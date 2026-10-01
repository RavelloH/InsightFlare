import {
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  param,
  unixepoch,
  update,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import {
  bad as badRequest,
  bool,
  forb,
  jsonResponseFor,
  na,
  parseJson,
} from "@/lib/edge/admin/response";
import { SCHEDULED_TASKS } from "@/lib/edge/scheduled-tasks/registry";
import {
  readRetentionConfig,
  writeRetentionConfig,
} from "@/lib/edge/scheduled-tasks/retention-config";
import type { Env } from "@/lib/edge/types";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  InvalidCursorError,
  paginationBinding,
} from "@/lib/pagination";
import { mergeRetentionConfig } from "@/lib/retention";
import {
  type ScheduledTaskLogLevel,
  type ScheduledTaskRun,
  type ScheduledTaskRunGroup,
  type ScheduledTaskRunLog,
  type ScheduledTasksData,
  type ScheduledTaskStatus,
  type ScheduledTaskSummary,
} from "@/lib/scheduled-tasks";

import {
  buildCountRunLogsQuery,
  buildHealthQuery,
  buildLatestRunsQuery,
  buildPageTaskRunsQuery,
  buildRunGroupByIdQuery,
  buildRunGroupIdByRunIdQuery,
  buildRunGroupsPageQuery,
  buildRunLogsPageQuery,
  buildRunsByGroupIdQuery,
  buildScheduleStatesQuery,
  buildTaskStatsQuery,
} from "./query-plan";
type AdminActor = { isAdmin: boolean };
type AdminActorResolver = (
  env: Env,
  req: Request,
) => Promise<AdminActor | Response>;
const STATUS_VALUES = new Set<ScheduledTaskStatus>([
  "running",
  "success",
  "partial",
  "failed",
  "skipped",
]);
const STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RUN_PAGE_SIZE = 50;
const MAX_RUN_PAGE_SIZE = 100;
const DEFAULT_LOG_PAGE_SIZE = 200;
const MAX_LOG_PAGE_SIZE = 500;
const RUN_GROUP_STARTED_AT_BUCKET_MS = 10 * 60 * 1000;
type RelationResult<Query> = Query extends { readonly __row?: infer Row }
  ? NonNullable<Row>
  : never;
type RunRow = RelationResult<ReturnType<typeof buildRunsByGroupIdQuery>>;
type LogRow = RelationResult<ReturnType<typeof buildRunLogsPageQuery>>;
type RunGroupRow = RelationResult<ReturnType<typeof buildRunGroupsPageQuery>>;
type ScheduleStateRow = RelationResult<
  ReturnType<typeof buildScheduleStatesQuery>
>;
interface LogCursor {
  readonly runStartedAt: number;
  readonly runId: string;
  readonly sequence: number;
  readonly logId: string;
}
async function loadScheduleStates(env: Env): Promise<ScheduleStateRow[]> {
  try {
    const result = await createD1DatabaseClient(env.DB).all(
      compileD1Query(buildScheduleStatesQuery(), {
        tag: "admin.scheduled_task_schedule_state.all",
      }),
    );
    return result.results;
  } catch {
    return [];
  }
}
function safeParseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function normalizeStatus(value: string): ScheduledTaskStatus {
  return STATUS_VALUES.has(value as ScheduledTaskStatus)
    ? (value as ScheduledTaskStatus)
    : "failed";
}
function normalizeLogLevel(value: string): ScheduledTaskLogLevel {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return "info";
}
function mapRun(row: RunRow): ScheduledTaskRun {
  return {
    id: String(row.id ?? ""),
    invocationId: String(row.invocationId ?? ""),
    taskKey: String(row.taskKey ?? ""),
    taskName: String(row.taskName ?? ""),
    triggerType: String(row.triggerType ?? ""),
    status: normalizeStatus(String(row.status ?? "")),
    scheduledAt:
      row.scheduledAt === null || row.scheduledAt === undefined
        ? null
        : Number(row.scheduledAt),
    startedAt: Number(row.startedAt ?? 0),
    finishedAt:
      row.finishedAt === null || row.finishedAt === undefined
        ? null
        : Number(row.finishedAt),
    durationMs:
      row.durationMs === null || row.durationMs === undefined
        ? null
        : Number(row.durationMs),
    scopeType: String(row.scopeType ?? "system"),
    scopeId:
      row.scopeId === null || row.scopeId === undefined
        ? null
        : String(row.scopeId),
    summary: safeParseRecord(String(row.summaryJson ?? "{}")),
    errorName:
      row.errorName === null || row.errorName === undefined
        ? null
        : String(row.errorName),
    errorMessage:
      row.errorMessage === null || row.errorMessage === undefined
        ? null
        : String(row.errorMessage),
    workerVersion:
      row.workerVersion === null || row.workerVersion === undefined
        ? null
        : String(row.workerVersion),
    createdAt: Number(row.createdAt ?? 0) * 1000,
    expiresAt: Number(row.expiresAt ?? 0) * 1000,
  };
}
function mapLog(row: LogRow): ScheduledTaskRunLog {
  return {
    id: String(row.id ?? ""),
    runId: String(row.runId ?? ""),
    taskKey: String(row.taskKey ?? ""),
    sequence: Number(row.sequence ?? 0),
    level: normalizeLogLevel(String(row.level ?? "")),
    event: String(row.event ?? ""),
    message: String(row.message ?? ""),
    data: safeParseRecord(String(row.dataJson ?? "{}")),
    createdAt: Number(row.createdAt ?? 0),
  };
}
function aggregateRunSummary(
  runs: ScheduledTaskRun[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.summary)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      summary[key] = Number(summary[key] ?? 0) + value;
    }
  }
  return summary;
}
function runSubtaskCount(run: ScheduledTaskRun): number {
  const summary = run.summary;
  const key = Object.prototype.hasOwnProperty.call(summary, "rulesScanned")
    ? "rulesScanned"
    : Object.prototype.hasOwnProperty.call(summary, "candidateSites")
      ? "candidateSites"
      : Object.prototype.hasOwnProperty.call(summary, "sitesProcessed")
        ? "sitesProcessed"
        : null;
  const value = key ? summary[key] : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function mapRunGroup(
  row: RunGroupRow,
  runs: ScheduledTaskRun[] = [],
): ScheduledTaskRunGroup {
  const startedAt = Number(row.startedAt ?? 0);
  const finishedAt =
    row.finishedAt === null || row.finishedAt === undefined
      ? null
      : Number(row.finishedAt);
  return {
    id: String(row.id ?? ""),
    triggerType: String(row.triggerType ?? ""),
    status: normalizeStatus(String(row.status ?? "")),
    scheduledAt:
      row.scheduledAt === null || row.scheduledAt === undefined
        ? null
        : Number(row.scheduledAt),
    startedAt,
    finishedAt,
    durationMs:
      finishedAt === null ? null : Math.max(0, finishedAt - startedAt),
    taskCount: Number(row.taskCount ?? runs.length),
    subtaskCount: runs.reduce((total, run) => total + runSubtaskCount(run), 0),
    successCount: Number(row.successCount ?? 0),
    partialCount: Number(row.partialCount ?? 0),
    failedCount: Number(row.failedCount ?? 0),
    skippedCount: Number(row.skippedCount ?? 0),
    runningCount: Number(row.runningCount ?? 0),
    logsCount: Number(row.logsCount ?? 0),
    summary: aggregateRunSummary(runs),
    runs,
  };
}
const MAX_LOG_RUN_IDS_PER_QUERY = 100;
async function countRunLogs(env: Env, runIds: string[]): Promise<number> {
  let total = 0;
  for (
    let offset = 0;
    offset < runIds.length;
    offset += MAX_LOG_RUN_IDS_PER_QUERY
  ) {
    const chunk = runIds.slice(offset, offset + MAX_LOG_RUN_IDS_PER_QUERY);
    const row = await createD1DatabaseClient(env.DB).first(
      compileD1Query(buildCountRunLogsQuery(chunk), {
        tag: "admin.scheduled_task_run_logs.first",
      }),
    );
    total += Number(row?.count ?? 0);
  }
  return total;
}
function decodeScheduledLogCursor(value: unknown): LogCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "runStartedAt",
    "runId",
    "sequence",
    "logId",
  ]) &&
    Number.isSafeInteger(candidate.runStartedAt) &&
    typeof candidate.runId === "string" &&
    Number.isSafeInteger(candidate.sequence) &&
    typeof candidate.logId === "string"
    ? {
        runStartedAt: candidate.runStartedAt as number,
        runId: candidate.runId,
        sequence: candidate.sequence as number,
        logId: candidate.logId,
      }
    : null;
}
async function loadRunLogsPage(
  env: Env,
  runIds: string[],
  limit: number,
  cursor: LogCursor | null,
): Promise<{ rows: LogRow[]; hasMore: boolean; last: LogRow | undefined }> {
  if (runIds.length === 0) return { rows: [], hasMore: false, last: undefined };
  const rows: LogRow[] = [];
  for (
    let offset = 0;
    offset < runIds.length;
    offset += MAX_LOG_RUN_IDS_PER_QUERY
  ) {
    const chunk = runIds.slice(offset, offset + MAX_LOG_RUN_IDS_PER_QUERY);
    const result = await createD1DatabaseClient(env.DB).all(
      compileD1Query(buildRunLogsPageQuery(chunk, limit, cursor), {
        tag: "admin.scheduled_task_run_logs.all",
      }),
    );
    rows.push(...result.results);
  }
  rows.sort(
    (left, right) =>
      Number(left.runStartedAt ?? 0) - Number(right.runStartedAt ?? 0) ||
      String(left.runId).localeCompare(String(right.runId)) ||
      Number(left.sequence ?? 0) - Number(right.sequence ?? 0) ||
      String(left.id).localeCompare(String(right.id)),
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return { rows: pageRows, hasMore, last: pageRows.at(-1) };
}
function scheduledLogsBinding(groupId: string, runIds: readonly string[]) {
  return paginationBinding([
    "scheduled-task-logs-v1",
    groupId,
    [...runIds].sort(),
    "runStartedAt:asc,runId:asc,sequence:asc,logId:asc",
  ]);
}
function successRate(success: number, total: number): number | null {
  return total > 0 ? success / total : null;
}
function scheduledRunGroupId(run: ScheduledTaskRun): string {
  if (run.scheduledAt === null) return run.invocationId;
  return [
    run.triggerType,
    run.scheduledAt,
    Math.trunc(run.startedAt / RUN_GROUP_STARTED_AT_BUCKET_MS),
  ].join(":");
}
function parseRunLimit(url: URL): number {
  const value = Math.trunc(
    Number(url.searchParams.get("limit") ?? DEFAULT_RUN_PAGE_SIZE),
  );
  if (!Number.isFinite(value)) return DEFAULT_RUN_PAGE_SIZE;
  return Math.min(MAX_RUN_PAGE_SIZE, Math.max(1, value));
}
function parseLogLimit(url: URL): number {
  const value = Math.trunc(
    Number(url.searchParams.get("logLimit") ?? DEFAULT_LOG_PAGE_SIZE),
  );
  if (!Number.isFinite(value)) return DEFAULT_LOG_PAGE_SIZE;
  return Math.min(MAX_LOG_PAGE_SIZE, Math.max(1, value));
}
function scheduledRunsBinding(status: string): Promise<string> {
  return paginationBinding([
    "admin-scheduled-runs-v1",
    status,
    "startedAt:desc,groupId:asc",
  ]);
}
function scheduledRunCursor(value: unknown): {
  readonly startedAt: number;
  readonly groupId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["startedAt", "groupId"]) &&
    typeof candidate.startedAt === "number" &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.groupId === "string"
    ? { startedAt: candidate.startedAt, groupId: candidate.groupId }
    : null;
}
export async function handleScheduledTasksAdmin(
  req: Request,
  env: Env,
  url: URL,
  requireActor: AdminActorResolver,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb("Only system admin can view scheduled tasks", undefined, req);
  if (req.method !== "GET" && req.method !== "PATCH") return na(req);
  const db = createD1DatabaseClient(env.DB);

  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const taskKey = typeof body.taskKey === "string" ? body.taskKey.trim() : "";
    if (body.enabled !== undefined) {
      const task = SCHEDULED_TASKS.find((item) => item.key === taskKey);
      if (!task) return badRequest("Unknown scheduled task", undefined, req);
      await db.run(
        compileD1Mutation(
          update(schema.scheduled_task_schedule_state, (columns) => ({
            set: {
              enabled: bool(body.enabled) ? 1 : 0,
              updated_at: unixepoch(),
            },
            where: eq(columns.task_key, param(task.key)),
          })),
          { tag: "admin.scheduled_tasks.update_enabled" },
        ),
      );
    }

    const retentionPatch =
      body.retention &&
      typeof body.retention === "object" &&
      !Array.isArray(body.retention)
        ? (body.retention as Record<string, unknown>)
        : {};
    if (body.retentionDays !== undefined) {
      retentionPatch.scheduledTaskLogsDays = body.retentionDays;
    }
    if (Object.keys(retentionPatch).length > 0) {
      const current = await readRetentionConfig(env);
      await writeRetentionConfig(
        env,
        mergeRetentionConfig(current, retentionPatch),
      );
    }
  }

  const generatedAt = Date.now();
  // The rolling stats window is concrete for each request, but intentionally
  // does not participate in the grouped run-list cursor identity. This keeps
  // a cursor usable when the request crosses a minute boundary.
  const since30d = Math.floor(generatedAt / 60_000) * 60_000 - STATS_WINDOW_MS;
  const since24h = generatedAt - 24 * 60 * 60 * 1000;
  const staleBefore = generatedAt - STALE_RUNNING_MS;
  const limit = parseRunLimit(url);
  const status = (url.searchParams.get("status") || "").trim();
  const runId = (
    url.searchParams.get("runId") ||
    url.searchParams.get("runGroupId") ||
    ""
  ).trim();
  const statusFilter = STATUS_VALUES.has(status as ScheduledTaskStatus)
    ? status
    : "";
  const rawCursor = url.searchParams.get("cursor");
  const runsBinding = await scheduledRunsBinding(statusFilter);
  let cursor: { readonly startedAt: number; readonly groupId: string } | null;
  try {
    cursor = await decodePageCursor(
      env,
      runsBinding,
      rawCursor,
      "scheduled-runs",
      scheduledRunCursor,
    );
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return badRequest("Invalid cursor", undefined, req);
    }
    throw error;
  }
  const [healthRow, statsRows, latestRows, runRows] = await Promise.all([
    db.first(
      compileD1Query(buildHealthQuery(since24h, staleBefore), {
        tag: "admin.scheduled_task_runs.first",
      }),
    ),
    db.all(
      compileD1Query(buildTaskStatsQuery(since30d), {
        tag: "admin.scheduled_task_runs.all",
      }),
    ),
    db.all(
      compileD1Query(buildLatestRunsQuery(since30d), {
        tag: "admin.scheduled_task_runs.all",
      }),
    ),
    db.all(
      compileD1Query(
        buildRunGroupsPageQuery({
          since30d,
          status: statusFilter,
          cursor,
          limit,
        }),
        { tag: "admin.handler.all" },
      ),
    ),
  ]);

  const hasMoreRuns = runRows.results.length > limit;
  const requestedGroupRows = hasMoreRuns
    ? runRows.results.slice(0, limit)
    : runRows.results;
  const groupIds = requestedGroupRows.map((row) => String(row.id ?? ""));
  const pageTaskRows =
    groupIds.length > 0
      ? await db.all(
          compileD1Query(buildPageTaskRunsQuery(groupIds), {
            tag: "admin.handler.all",
          }),
        )
      : { results: [] as RunRow[] };
  const taskRunsByGroup = new Map<string, ScheduledTaskRun[]>();
  for (const run of pageTaskRows.results.map(mapRun)) {
    const groupId = scheduledRunGroupId(run);
    const groupRuns = taskRunsByGroup.get(groupId) ?? [];
    groupRuns.push(run);
    taskRunsByGroup.set(groupId, groupRuns);
  }
  const runs = requestedGroupRows.map((row) =>
    mapRunGroup(row, taskRunsByGroup.get(String(row.id ?? "")) ?? []),
  );
  let selectedRun = runId ? null : runs.length > 0 ? (runs[0] ?? null) : null;
  let selectedTaskRuns: ScheduledTaskRun[] = [];
  if (selectedRun && !runId) {
    selectedTaskRuns = selectedRun.runs;
  } else if (runId) {
    const selectedGroupId = runId;
    let selectedRow = await db.first(
      compileD1Query(buildRunGroupByIdQuery(selectedGroupId), {
        tag: "admin.handler.first",
      }),
    );
    if (!selectedRow) {
      const directRun = await db.first(
        compileD1Query(buildRunGroupIdByRunIdQuery(runId), {
          tag: "admin.scheduled_task_runs.first",
        }),
      );
      if (directRun?.id) {
        selectedRow = await db.first(
          compileD1Query(buildRunGroupByIdQuery(String(directRun.id)), {
            tag: "admin.handler.first",
          }),
        );
      }
    }
    const detailGroupId = String(selectedRow?.id ?? selectedGroupId);
    selectedTaskRuns = selectedRow
      ? (
          await db.all(
            compileD1Query(buildRunsByGroupIdQuery(detailGroupId), {
              tag: "admin.handler.all",
            }),
          )
        ).results.map(mapRun)
      : [];
    if (selectedRow) {
      selectedRow = {
        ...selectedRow,
        logsCount: await countRunLogs(
          env,
          selectedTaskRuns.map((run) => run.id),
        ),
      };
      selectedRun = mapRunGroup(selectedRow, selectedTaskRuns);
    } else {
      selectedRun = null;
    }
  }

  const logLimit = parseLogLimit(url);
  const selectedRunIds = selectedTaskRuns.map((run) => run.id);
  const logsBinding = await scheduledLogsBinding(
    selectedRun?.id ?? "none",
    selectedRunIds,
  );
  let logCursor: LogCursor | null = null;
  try {
    logCursor = await decodePageCursor(
      env,
      logsBinding,
      url.searchParams.get("logCursor"),
      "scheduled-task-logs",
      decodeScheduledLogCursor,
    );
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return badRequest("Invalid log cursor", undefined, req);
    }
    throw error;
  }
  const logPage = await loadRunLogsPage(
    env,
    selectedRunIds,
    logLimit,
    logCursor,
  );
  const lastLog = logPage.last;
  const nextLogCursor =
    logPage.hasMore && lastLog
      ? await encodePageCursor(env, logsBinding, {
          runStartedAt: Number(lastLog.runStartedAt ?? 0),
          runId: lastLog.runId,
          sequence: Number(lastLog.sequence ?? 0),
          logId: lastLog.id,
        })
      : null;

  const [scheduleStates, retention] = await Promise.all([
    loadScheduleStates(env),
    readRetentionConfig(env),
  ]);
  const stateByTask = new Map(
    scheduleStates.map((row) => [String(row.taskKey), row]),
  );

  const statsByTask = new Map(
    statsRows.results.map((row) => [String(row.taskKey ?? ""), row]),
  );
  const lastRunByTask = new Map(
    latestRows.results.map((row) => [String(row.taskKey ?? ""), mapRun(row)]),
  );
  const tasks: ScheduledTaskSummary[] = SCHEDULED_TASKS.map((task) => {
    const stats = statsByTask.get(task.key);
    const runs30d = Number(stats?.runs30d ?? 0);
    const success30d = Number(stats?.success30d ?? 0);
    const state = stateByTask.get(task.key);
    return {
      key: task.key,
      name: task.name,
      description: task.description,
      schedule: task.schedule,
      trigger: task.trigger,
      enabled: state ? state.enabled !== 0 : task.enabled,
      nextRunAt:
        !state ||
        state.enabled === 0 ||
        state.nextRunAt === undefined ||
        Number(state.nextRunAt) <= 0
          ? null
          : Number(state.nextRunAt) * 1000,
      lastRun: lastRunByTask.get(task.key) ?? null,
      runs30d,
      success30d,
      partial30d: Number(stats?.partial30d ?? 0),
      failed30d: Number(stats?.failed30d ?? 0),
      skipped30d: Number(stats?.skipped30d ?? 0),
      running: Number(stats?.running ?? 0),
      successRate30d: successRate(success30d, runs30d),
      avgDurationMs:
        stats?.avgDurationMs === null || stats?.avgDurationMs === undefined
          ? null
          : Number(stats.avgDurationMs),
    };
  });

  const lastGroup = requestedGroupRows.at(-1);
  const nextCursor =
    hasMoreRuns && lastGroup
      ? await encodePageCursor(env, runsBinding, {
          startedAt: Number(lastGroup.startedAt),
          groupId: String(lastGroup.id),
        })
      : null;

  const totalRuns24h = Number(healthRow?.totalRuns24h ?? 0);
  const successRuns24h = Number(healthRow?.successRuns24h ?? 0);
  const data: ScheduledTasksData = {
    ok: true,
    generatedAt,
    retentionDays: retention.scheduledTaskLogsDays,
    retention,
    tasks,
    runs: {
      items: runs,
      pagination: {
        limit,
        returned: runs.length,
        hasMore: hasMoreRuns,
        nextCursor,
      },
    },
    selectedRun,
    logs: {
      items: logPage.rows.map(mapLog),
      pagination: {
        limit: logLimit,
        returned: logPage.rows.length,
        hasMore: logPage.hasMore,
        nextCursor: nextLogCursor,
      },
    },
    health: {
      totalRuns24h,
      failedRuns24h: Number(healthRow?.failedRuns24h ?? 0),
      partialRuns24h: Number(healthRow?.partialRuns24h ?? 0),
      runningRuns: Number(healthRow?.runningRuns ?? 0),
      staleRunningRuns: Number(healthRow?.staleRunningRuns ?? 0),
      successRate24h: successRate(successRuns24h, totalRuns24h),
      lastRunAt:
        healthRow?.lastRunAt === null || healthRow?.lastRunAt === undefined
          ? null
          : Number(healthRow.lastRunAt),
    },
  };
  return jsonResponseFor(req, data);
}
