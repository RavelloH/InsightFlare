import {
  aggregate,
  and,
  avg,
  caseWhen,
  castInteger,
  concatText,
  count,
  div,
  eq,
  filter,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  join,
  limit,
  lt,
  max,
  min,
  or,
  param,
  project,
  rowNumber,
  scan,
  sort,
  sum,
  window,
} from "@/lib/db";
import type {
  ColumnExpression,
  ExpressionResultType,
  Predicate,
} from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";

const GROUP_BUCKET_MS = 10 * 60 * 1000;

function runRows() {
  const runs = scan(schema.scheduled_task_runs);
  return project(runs, {
    id: runs.columns.id,
    invocationId: runs.columns.invocation_id,
    taskKey: runs.columns.task_key,
    taskName: runs.columns.task_name,
    triggerType: runs.columns.trigger_type,
    status: runs.columns.status,
    scheduledAt: runs.columns.scheduled_at_ms,
    startedAt: runs.columns.started_at_ms,
    finishedAt: runs.columns.finished_at_ms,
    durationMs: runs.columns.duration_ms,
    scopeType: runs.columns.scope_type,
    scopeId: runs.columns.scope_id,
    summaryJson: runs.columns.summary_json,
    errorName: runs.columns.error_name,
    errorMessage: runs.columns.error_message,
    workerVersion: runs.columns.worker_version,
    createdAt: runs.columns.created_at,
    expiresAt: runs.columns.expires_at,
  });
}

function runRowsWithGroupId() {
  const runs = runRows();
  const columns = runs.columns;
  const groupId = caseWhen(
    [
      {
        when: isNotNull(columns.scheduledAt),
        then: concatText(
          columns.triggerType,
          param(":"),
          columns.scheduledAt,
          param(":"),
          castInteger(div(columns.startedAt, param(GROUP_BUCKET_MS))),
        ),
      },
    ],
    columns.invocationId,
  );
  return project(runs, { ...columns, groupId });
}

function statusCount(expression: Predicate) {
  return sum(caseWhen([{ when: expression, then: param(1) }], param(0)));
}

type NullableCountColumn = ColumnExpression<
  number | null,
  ExpressionResultType<"numeric", true>
>;

function normalizeGroupStatus(columns: {
  readonly failedCount: NullableCountColumn;
  readonly runningCount: NullableCountColumn;
  readonly partialCount: NullableCountColumn;
  readonly skippedCount: NullableCountColumn;
  readonly successCount: NullableCountColumn;
}) {
  return caseWhen(
    [
      { when: gt(columns.failedCount, param(0)), then: param("failed") },
      { when: gt(columns.runningCount, param(0)), then: param("running") },
      { when: gt(columns.partialCount, param(0)), then: param("partial") },
      {
        when: and(
          gt(columns.skippedCount, param(0)),
          eq(columns.successCount, param(0)),
        ),
        then: param("skipped"),
      },
    ],
    param("success"),
  );
}

function groupedRunRows(since?: number, groupId?: string) {
  const base = runRowsWithGroupId();
  let filtered = base;
  if (since !== undefined)
    filtered = filter(filtered, gte(filtered.columns.startedAt, param(since)));
  if (groupId !== undefined)
    filtered = filter(filtered, eq(filtered.columns.groupId, param(groupId)));
  const columns = filtered.columns;
  const grouped = aggregate(filtered, {
    groupBy: { id: columns.groupId },
    aggregates: {
      triggerType: max(columns.triggerType),
      scheduledAt: min(columns.scheduledAt),
      startedAt: min(columns.startedAt),
      unfinishedCount: statusCount(isNull(columns.finishedAt)),
      finishedMax: max(columns.finishedAt),
      taskCount: count(),
      successCount: statusCount(eq(columns.status, param("success"))),
      partialCount: statusCount(eq(columns.status, param("partial"))),
      failedCount: statusCount(eq(columns.status, param("failed"))),
      skippedCount: statusCount(eq(columns.status, param("skipped"))),
      runningCount: statusCount(eq(columns.status, param("running"))),
    },
  });
  const groupedColumns = grouped.columns;
  return project(grouped, {
    id: groupedColumns.id,
    triggerType: groupedColumns.triggerType,
    scheduledAt: groupedColumns.scheduledAt,
    startedAt: groupedColumns.startedAt,
    finishedAt: caseWhen(
      [
        {
          when: gt(groupedColumns.unfinishedCount, param(0)),
          then: param(null),
        },
      ],
      groupedColumns.finishedMax,
    ),
    taskCount: groupedColumns.taskCount,
    successCount: groupedColumns.successCount,
    partialCount: groupedColumns.partialCount,
    failedCount: groupedColumns.failedCount,
    skippedCount: groupedColumns.skippedCount,
    runningCount: groupedColumns.runningCount,
    status: normalizeGroupStatus(groupedColumns),
  });
}

function filterGroups(
  groups: ReturnType<typeof groupedRunRows>,
  status: string,
  cursor?: { readonly startedAt: number; readonly groupId: string } | null,
) {
  let result = groups;
  if (status !== "")
    result = filter(result, eq(result.columns.status, param(status)));
  if (cursor) {
    result = filter(
      result,
      or(
        // The ordering cursor is lexicographic: startedAt DESC, id ASC.
        // Keep the strict comparison to preserve minute-boundary paging.
        lt(result.columns.startedAt, param(cursor.startedAt)),
        and(
          eq(result.columns.startedAt, param(cursor.startedAt)),
          gt(result.columns.id, param(cursor.groupId)),
        ),
      ),
    );
  }
  return result;
}

export function buildScheduleStatesQuery() {
  const states = scan(schema.scheduled_task_schedule_state);
  return project(states, {
    taskKey: states.columns.task_key,
    enabled: states.columns.enabled,
    nextRunAt: states.columns.next_run_at,
  });
}

export function buildCountRunLogsQuery(runIds: readonly string[]) {
  const logs = scan(schema.scheduled_task_run_logs);
  const matching = filter(logs, inList(logs.columns.run_id, runIds));
  return aggregate(matching, { groupBy: {}, aggregates: { count: count() } });
}

export function buildRunLogsPageQuery(
  runIds: readonly string[],
  pageLimit: number,
  cursor: ScheduledLogCursor | null,
) {
  const logs = scan(schema.scheduled_task_run_logs);
  const runs = runRows();
  const joined = join(logs, runs, eq(logs.columns.run_id, runs.columns.id));
  let matching = filter(joined, inList(joined.columns.left_run_id, runIds));
  if (cursor) {
    matching = filter(
      matching,
      or(
        gt(matching.columns.right_startedAt, param(cursor.runStartedAt)),
        and(
          eq(matching.columns.right_startedAt, param(cursor.runStartedAt)),
          or(
            gt(matching.columns.left_run_id, param(cursor.runId)),
            and(
              eq(matching.columns.left_run_id, param(cursor.runId)),
              or(
                gt(matching.columns.left_sequence, param(cursor.sequence)),
                and(
                  eq(matching.columns.left_sequence, param(cursor.sequence)),
                  gt(matching.columns.left_id, param(cursor.logId)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
  const selected = project(matching, {
    id: matching.columns.left_id,
    runId: matching.columns.left_run_id,
    taskKey: matching.columns.left_task_key,
    sequence: matching.columns.left_sequence,
    level: matching.columns.left_level,
    event: matching.columns.left_event,
    message: matching.columns.left_message,
    dataJson: matching.columns.left_data_json,
    createdAt: matching.columns.left_created_at_ms,
    runStartedAt: matching.columns.right_startedAt,
  });
  return limit(
    sort(selected, [
      { expression: selected.columns.runStartedAt, direction: "ASC" },
      { expression: selected.columns.runId, direction: "ASC" },
      { expression: selected.columns.sequence, direction: "ASC" },
      { expression: selected.columns.id, direction: "ASC" },
    ]),
    pageLimit + 1,
  );
}

export function buildHealthQuery(since24h: number, staleBefore: number) {
  const base = runRowsWithGroupId();
  const recent = filter(base, gte(base.columns.startedAt, param(since24h)));
  const columns = recent.columns;
  const grouped = aggregate(recent, {
    groupBy: { id: columns.groupId },
    aggregates: {
      startedAt: min(columns.startedAt),
      successCount: statusCount(eq(columns.status, param("success"))),
      partialCount: statusCount(eq(columns.status, param("partial"))),
      failedCount: statusCount(eq(columns.status, param("failed"))),
      skippedCount: statusCount(eq(columns.status, param("skipped"))),
      runningCount: statusCount(eq(columns.status, param("running"))),
      staleRunningCount: sum(
        caseWhen(
          [
            {
              when: and(
                eq(columns.status, param("running")),
                lt(columns.startedAt, param(staleBefore)),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
    },
  });
  const groupedColumns = grouped.columns;
  const normalized = project(grouped, {
    startedAt: groupedColumns.startedAt,
    failedCount: groupedColumns.failedCount,
    partialCount: groupedColumns.partialCount,
    runningCount: groupedColumns.runningCount,
    staleRunningCount: groupedColumns.staleRunningCount,
    successCount: groupedColumns.successCount,
    skippedCount: groupedColumns.skippedCount,
    status: normalizeGroupStatus(groupedColumns),
  });
  const status = normalized.columns.status;
  return aggregate(normalized, {
    groupBy: {},
    aggregates: {
      totalRuns24h: count(),
      failedRuns24h: statusCount(eq(status, param("failed"))),
      partialRuns24h: statusCount(eq(status, param("partial"))),
      runningRuns: statusCount(eq(status, param("running"))),
      staleRunningRuns: statusCount(
        and(
          eq(status, param("running")),
          gt(normalized.columns.staleRunningCount, param(0)),
        ),
      ),
      successRuns24h: statusCount(eq(status, param("success"))),
      lastRunAt: max(normalized.columns.startedAt),
    },
  });
}

export function buildTaskStatsQuery(since30d: number) {
  const runs = scan(schema.scheduled_task_runs);
  const recent = filter(runs, gte(runs.columns.started_at_ms, param(since30d)));
  return aggregate(recent, {
    groupBy: { taskKey: recent.columns.task_key },
    aggregates: {
      runs30d: count(),
      success30d: statusCount(eq(recent.columns.status, param("success"))),
      partial30d: statusCount(eq(recent.columns.status, param("partial"))),
      failed30d: statusCount(eq(recent.columns.status, param("failed"))),
      skipped30d: statusCount(eq(recent.columns.status, param("skipped"))),
      running: statusCount(eq(recent.columns.status, param("running"))),
      avgDurationMs: avg(
        caseWhen([
          {
            when: isNotNull(recent.columns.duration_ms),
            then: recent.columns.duration_ms,
          },
        ]),
      ),
    },
  });
}

export function buildLatestRunsQuery(since30d: number) {
  const source = runRows();
  const recent = filter(source, gte(source.columns.startedAt, param(since30d)));
  const ranked = window(recent, {
    latestRank: rowNumber({
      partitionBy: [recent.columns.taskKey],
      orderBy: [{ expression: recent.columns.startedAt, direction: "DESC" }],
    }),
  });
  const latest = filter(ranked, eq(ranked.columns.latestRank, param(1)));
  return project(latest, {
    id: latest.columns.id,
    invocationId: latest.columns.invocationId,
    taskKey: latest.columns.taskKey,
    taskName: latest.columns.taskName,
    triggerType: latest.columns.triggerType,
    status: latest.columns.status,
    scheduledAt: latest.columns.scheduledAt,
    startedAt: latest.columns.startedAt,
    finishedAt: latest.columns.finishedAt,
    durationMs: latest.columns.durationMs,
    scopeType: latest.columns.scopeType,
    scopeId: latest.columns.scopeId,
    summaryJson: latest.columns.summaryJson,
    errorName: latest.columns.errorName,
    errorMessage: latest.columns.errorMessage,
    workerVersion: latest.columns.workerVersion,
    createdAt: latest.columns.createdAt,
    expiresAt: latest.columns.expiresAt,
  });
}

export interface RunGroupCursor {
  readonly startedAt: number;
  readonly groupId: string;
}

export interface ScheduledLogCursor {
  readonly runStartedAt: number;
  readonly runId: string;
  readonly sequence: number;
  readonly logId: string;
}

export function buildRunGroupsPageQuery(options: {
  readonly since30d: number;
  readonly status: string;
  readonly cursor: RunGroupCursor | null;
  readonly limit: number;
}) {
  const filtered = filterGroups(
    groupedRunRows(options.since30d),
    options.status,
    options.cursor,
  );
  const pageGroups = limit(
    sort(filtered, [
      { expression: filtered.columns.startedAt, direction: "DESC" },
      { expression: filtered.columns.id, direction: "ASC" },
    ]),
    options.limit + 1,
  );

  // Join the page to every member, without the 30-day predicate, so older
  // members and their logs remain part of the displayed group. Aggregating
  // after both left joins keeps the limited page relation on one plan branch.
  const allRuns = runRowsWithGroupId();
  const pageRuns = join(
    pageGroups,
    allRuns,
    eq(pageGroups.columns.id, allRuns.columns.groupId),
    "left",
  );
  const logs = scan(schema.scheduled_task_run_logs);
  const runLogs = join(
    pageRuns,
    logs,
    eq(pageRuns.columns.right_id, logs.columns.run_id),
    "left",
  );
  const selected = aggregate(runLogs, {
    groupBy: { id: runLogs.columns.left_left_id },
    aggregates: {
      triggerType: max(runLogs.columns.left_left_triggerType),
      scheduledAt: max(runLogs.columns.left_left_scheduledAt),
      startedAt: max(runLogs.columns.left_left_startedAt),
      finishedAt: max(runLogs.columns.left_left_finishedAt),
      taskCount: max(runLogs.columns.left_left_taskCount),
      successCount: max(runLogs.columns.left_left_successCount),
      partialCount: max(runLogs.columns.left_left_partialCount),
      failedCount: max(runLogs.columns.left_left_failedCount),
      skippedCount: max(runLogs.columns.left_left_skippedCount),
      runningCount: max(runLogs.columns.left_left_runningCount),
      status: max(runLogs.columns.left_left_status),
      logsCount: count(runLogs.columns.right_id),
    },
  });
  return sort(selected, [
    { expression: selected.columns.startedAt, direction: "DESC" },
    { expression: selected.columns.id, direction: "ASC" },
  ]);
}

export function buildPageTaskRunsQuery(groupIds: readonly string[]) {
  const runs = runRowsWithGroupId();
  const matching = filter(runs, inList(runs.columns.groupId, groupIds));
  const selected = project(matching, {
    id: matching.columns.id,
    invocationId: matching.columns.invocationId,
    taskKey: matching.columns.taskKey,
    taskName: matching.columns.taskName,
    triggerType: matching.columns.triggerType,
    status: matching.columns.status,
    scheduledAt: matching.columns.scheduledAt,
    startedAt: matching.columns.startedAt,
    finishedAt: matching.columns.finishedAt,
    durationMs: matching.columns.durationMs,
    scopeType: matching.columns.scopeType,
    scopeId: matching.columns.scopeId,
    summaryJson: matching.columns.summaryJson,
    errorName: matching.columns.errorName,
    errorMessage: matching.columns.errorMessage,
    workerVersion: matching.columns.workerVersion,
    createdAt: matching.columns.createdAt,
    expiresAt: matching.columns.expiresAt,
  });
  return sort(selected, [
    { expression: selected.columns.startedAt, direction: "ASC" },
    { expression: selected.columns.taskKey, direction: "ASC" },
  ]);
}

export function buildRunGroupByIdQuery(groupId: string) {
  const groups = groupedRunRows(undefined, groupId);
  return limit(
    project(groups, {
      id: groups.columns.id,
      triggerType: groups.columns.triggerType,
      scheduledAt: groups.columns.scheduledAt,
      startedAt: groups.columns.startedAt,
      finishedAt: groups.columns.finishedAt,
      taskCount: groups.columns.taskCount,
      successCount: groups.columns.successCount,
      partialCount: groups.columns.partialCount,
      failedCount: groups.columns.failedCount,
      skippedCount: groups.columns.skippedCount,
      runningCount: groups.columns.runningCount,
      status: groups.columns.status,
      logsCount: param(0 as number),
    }),
    1,
  );
}

export function buildRunGroupIdByRunIdQuery(runId: string) {
  const runs = runRowsWithGroupId();
  const matching = filter(runs, eq(runs.columns.id, param(runId)));
  return limit(project(matching, { id: matching.columns.groupId }), 1);
}

export function buildRunsByGroupIdQuery(groupId: string) {
  const runs = runRowsWithGroupId();
  const matching = filter(runs, eq(runs.columns.groupId, param(groupId)));
  const selected = project(matching, {
    id: matching.columns.id,
    invocationId: matching.columns.invocationId,
    taskKey: matching.columns.taskKey,
    taskName: matching.columns.taskName,
    triggerType: matching.columns.triggerType,
    status: matching.columns.status,
    scheduledAt: matching.columns.scheduledAt,
    startedAt: matching.columns.startedAt,
    finishedAt: matching.columns.finishedAt,
    durationMs: matching.columns.durationMs,
    scopeType: matching.columns.scopeType,
    scopeId: matching.columns.scopeId,
    summaryJson: matching.columns.summaryJson,
    errorName: matching.columns.errorName,
    errorMessage: matching.columns.errorMessage,
    workerVersion: matching.columns.workerVersion,
    createdAt: matching.columns.createdAt,
    expiresAt: matching.columns.expiresAt,
  });
  return sort(selected, [
    { expression: selected.columns.startedAt, direction: "ASC" },
    { expression: selected.columns.taskKey, direction: "ASC" },
  ]);
}
