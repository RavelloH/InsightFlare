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
  bad as badRequest,
  bool,
  forb,
  jsonResponseFor,
  na,
  parseJson,
} from "./admin-response";
import { readRetentionConfig, writeRetentionConfig } from "./retention-config";
import { SCHEDULED_TASKS } from "./scheduled-task-registry";
import type { Env } from "./types";

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

interface RunRow {
  id: string;
  invocationId: string;
  taskKey: string;
  taskName: string;
  triggerType: string;
  status: string;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  scopeType: string;
  scopeId: string | null;
  summaryJson: string;
  errorName: string | null;
  errorMessage: string | null;
  workerVersion: string | null;
  createdAt: number;
  expiresAt: number;
}

interface LogRow {
  id: string;
  runId: string;
  taskKey: string;
  sequence: number;
  level: string;
  event: string;
  message: string;
  dataJson: string;
  createdAt: number;
  runStartedAt?: number;
}

interface LogCursor {
  readonly runStartedAt: number;
  readonly runId: string;
  readonly sequence: number;
  readonly logId: string;
}

interface RunGroupRow {
  id: string;
  triggerType: string;
  status: string;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  taskCount: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  skippedCount: number;
  runningCount: number;
  logsCount: number;
}

interface TaskStatsRow {
  taskKey: string;
  runs30d: number;
  success30d: number;
  partial30d: number;
  failed30d: number;
  skipped30d: number;
  running: number;
  avgDurationMs: number | null;
}

interface HealthRow {
  totalRuns24h: number;
  failedRuns24h: number;
  partialRuns24h: number;
  runningRuns: number;
  staleRunningRuns: number;
  successRuns24h: number;
  lastRunAt: number | null;
}

interface ScheduleStateRow {
  taskKey: string;
  enabled: number;
  nextRunAt: number;
}

async function loadScheduleStates(env: Env): Promise<ScheduleStateRow[]> {
  try {
    const result = await env.DB.prepare(
      `
        SELECT
          task_key AS taskKey,
          enabled,
          next_run_at AS nextRunAt
        FROM scheduled_task_schedule_state
      `,
    )
      .bind()
      .all<ScheduleStateRow>();
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

const RUN_SELECT_COLUMNS = `
      id,
      invocation_id AS invocationId,
      task_key AS taskKey,
      task_name AS taskName,
      trigger_type AS triggerType,
      status,
      scheduled_at_ms AS scheduledAt,
      started_at_ms AS startedAt,
      finished_at_ms AS finishedAt,
      duration_ms AS durationMs,
      scope_type AS scopeType,
      scope_id AS scopeId,
      summary_json AS summaryJson,
      error_name AS errorName,
      error_message AS errorMessage,
      worker_version AS workerVersion,
      created_at AS createdAt,
      expires_at AS expiresAt
`;

function runSelectSql(whereClause: string): string {
  return `
    SELECT
      ${RUN_SELECT_COLUMNS}
    FROM scheduled_task_runs
    ${whereClause}
  `;
}

const RUN_GROUP_KEY_SQL = `
      CASE
        WHEN scheduled_at_ms IS NOT NULL THEN trigger_type || ':' || scheduled_at_ms || ':' || CAST(started_at_ms / ${RUN_GROUP_STARTED_AT_BUCKET_MS} AS INTEGER)
        ELSE invocation_id
      END
`;
const RUNS_GROUP_KEY_SQL = RUN_GROUP_KEY_SQL.replaceAll(
  "scheduled_",
  "runs.scheduled_",
)
  .replaceAll("trigger_type", "runs.trigger_type")
  .replaceAll("invocation_id", "runs.invocation_id");

function runGroupSelectSql(whereClause: string): string {
  return `
    WITH grouped AS (
      SELECT
        ${RUN_GROUP_KEY_SQL} AS id,
        MAX(trigger_type) AS triggerType,
        MIN(scheduled_at_ms) AS scheduledAt,
        MIN(started_at_ms) AS startedAt,
        CASE
          WHEN SUM(CASE WHEN finished_at_ms IS NULL THEN 1 ELSE 0 END) > 0
            THEN NULL
          ELSE MAX(finished_at_ms)
        END AS finishedAt,
        COUNT(*) AS taskCount,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount
      FROM scheduled_task_runs
      ${whereClause}
      GROUP BY ${RUN_GROUP_KEY_SQL}
    ),
    normalized AS (
      SELECT
        *,
        CASE
          WHEN failedCount > 0 THEN 'failed'
          WHEN runningCount > 0 THEN 'running'
          WHEN partialCount > 0 THEN 'partial'
          WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
          ELSE 'success'
        END AS status
      FROM grouped
    )
    SELECT
      normalized.*,
      0 AS logsCount
    FROM normalized
  `;
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
    const row = await env.DB.prepare(
      `
        SELECT COUNT(*) AS count
        FROM scheduled_task_run_logs
        WHERE run_id IN (${chunk.map(() => "?").join(", ")})
      `,
    )
      .bind(...chunk)
      .first<{ count: number }>();
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
    const cursorClause = cursor
      ? "AND (runs.started_at_ms > ? OR (runs.started_at_ms = ? AND (logs.run_id > ? OR (logs.run_id = ? AND (logs.sequence > ? OR (logs.sequence = ? AND logs.id > ?))))))"
      : "";
    const result = await env.DB.prepare(
      `
        SELECT
          logs.id,
          logs.run_id AS runId,
          logs.task_key AS taskKey,
          logs.sequence,
          logs.level,
          logs.event,
          logs.message,
          logs.data_json AS dataJson,
          logs.created_at_ms AS createdAt,
          runs.started_at_ms AS runStartedAt
        FROM scheduled_task_run_logs logs
        INNER JOIN scheduled_task_runs runs ON runs.id = logs.run_id
        WHERE logs.run_id IN (${chunk.map(() => "?").join(", ")})
          ${cursorClause}
        ORDER BY runs.started_at_ms ASC, logs.run_id ASC, logs.sequence ASC, logs.id ASC
        LIMIT ?
      `,
    )
      .bind(
        ...chunk,
        ...(cursor
          ? [
              cursor.runStartedAt,
              cursor.runStartedAt,
              cursor.runId,
              cursor.runId,
              cursor.sequence,
              cursor.sequence,
              cursor.logId,
            ]
          : []),
        limit + 1,
      )
      .all<LogRow>();
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

function runGroupPageSelectSql(
  whereClause: string,
  cursor?: {
    readonly startedAt: number;
    readonly groupId: string;
  } | null,
): string {
  const cursorClause = cursor
    ? "WHERE (startedAt < ? OR (startedAt = ? AND id > ?))"
    : "";
  return `
    WITH grouped AS (
      SELECT
        ${RUN_GROUP_KEY_SQL} AS id,
        MAX(trigger_type) AS triggerType,
        MIN(scheduled_at_ms) AS scheduledAt,
        MIN(started_at_ms) AS startedAt,
        CASE
          WHEN SUM(CASE WHEN finished_at_ms IS NULL THEN 1 ELSE 0 END) > 0
            THEN NULL
          ELSE MAX(finished_at_ms)
        END AS finishedAt,
        COUNT(*) AS taskCount,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount
      FROM scheduled_task_runs
      ${whereClause}
      GROUP BY ${RUN_GROUP_KEY_SQL}
    ),
    normalized AS (
      SELECT
        *,
        CASE
          WHEN failedCount > 0 THEN 'failed'
          WHEN runningCount > 0 THEN 'running'
          WHEN partialCount > 0 THEN 'partial'
          WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
          ELSE 'success'
        END AS status
      FROM grouped
    ),
    filtered_groups AS (
      SELECT *
      FROM normalized
      WHERE (? = '' OR status = ?)
    ),
    page_groups AS (
      SELECT *
      FROM filtered_groups
      ${cursorClause}
      ORDER BY startedAt DESC, id ASC
      LIMIT ?
    ),
    page_runs AS (
      SELECT
        runs.id,
        ${RUNS_GROUP_KEY_SQL} AS groupId
      FROM scheduled_task_runs runs
      INNER JOIN page_groups pg
        ON pg.id = ${RUNS_GROUP_KEY_SQL}
    ),
    page_log_counts AS (
      SELECT
        pr.groupId,
        COUNT(*) AS logsCount
      FROM page_runs pr
      INNER JOIN scheduled_task_run_logs logs
        ON logs.run_id = pr.id
      GROUP BY pr.groupId
    )
    SELECT
      pg.*,
      COALESCE(plc.logsCount, 0) AS logsCount
    FROM page_groups pg
    LEFT JOIN page_log_counts plc ON plc.groupId = pg.id
    ORDER BY pg.startedAt DESC, pg.id ASC
  `;
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

function scheduledRunsBinding(
  sinceMs: number,
  status: string,
): Promise<string> {
  return paginationBinding([
    "admin-scheduled-runs-v1",
    sinceMs,
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

  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const taskKey = typeof body.taskKey === "string" ? body.taskKey.trim() : "";
    if (body.enabled !== undefined) {
      const task = SCHEDULED_TASKS.find((item) => item.key === taskKey);
      if (!task) return badRequest("Unknown scheduled task", undefined, req);
      await env.DB.prepare(
        `
          UPDATE scheduled_task_schedule_state
          SET enabled = ?, updated_at = unixepoch()
          WHERE task_key = ?
        `,
      )
        .bind(bool(body.enabled) ? 1 : 0, task.key)
        .run();
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
  // Keep the cursor binding stable for the lifetime of a short-lived admin
  // browsing session. The SQL window is concrete, but minute normalization
  // avoids invalidating the next request merely because Date.now() advanced.
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
  const runFilters: string[] = ["started_at_ms >= ?"];
  const runBindings: Array<string | number> = [since30d];
  const statusFilter = STATUS_VALUES.has(status as ScheduledTaskStatus)
    ? status
    : "";
  const rawCursor = url.searchParams.get("cursor");
  const runsBinding = await scheduledRunsBinding(since30d, statusFilter);
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
    env.DB.prepare(
      `
        WITH grouped AS (
          SELECT
            ${RUN_GROUP_KEY_SQL} AS id,
            MIN(started_at_ms) AS startedAt,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount,
            SUM(CASE WHEN status = 'running' AND started_at_ms < ? THEN 1 ELSE 0 END) AS staleRunningCount
          FROM scheduled_task_runs
          WHERE started_at_ms >= ?
          GROUP BY ${RUN_GROUP_KEY_SQL}
        ),
        normalized AS (
          SELECT
            *,
            CASE
              WHEN failedCount > 0 THEN 'failed'
              WHEN runningCount > 0 THEN 'running'
              WHEN partialCount > 0 THEN 'partial'
              WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
              ELSE 'success'
            END AS status
          FROM grouped
        )
        SELECT
          COUNT(*) AS totalRuns24h,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns24h,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialRuns24h,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningRuns,
          SUM(CASE WHEN status = 'running' AND staleRunningCount > 0 THEN 1 ELSE 0 END) AS staleRunningRuns,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successRuns24h,
          MAX(startedAt) AS lastRunAt
        FROM normalized
      `,
    )
      .bind(staleBefore, since24h)
      .first<HealthRow>(),
    env.DB.prepare(
      `
        SELECT
          task_key AS taskKey,
          COUNT(*) AS runs30d,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success30d,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial30d,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed30d,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped30d,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avgDurationMs
        FROM scheduled_task_runs
        WHERE started_at_ms >= ?
        GROUP BY task_key
      `,
    )
      .bind(since30d)
      .all<TaskStatsRow>(),
    env.DB.prepare(
      `
        WITH ranked AS (
          SELECT
            ${RUN_SELECT_COLUMNS},
            ROW_NUMBER() OVER (PARTITION BY task_key ORDER BY started_at_ms DESC) AS rn
          FROM scheduled_task_runs
          WHERE started_at_ms >= ?
        )
        SELECT *
        FROM ranked
        WHERE rn = 1
      `,
    )
      .bind(since30d)
      .all<RunRow>(),
    env.DB.prepare(
      runGroupPageSelectSql(`WHERE ${runFilters.join(" AND ")}`, cursor),
    )
      .bind(
        ...runBindings,
        statusFilter,
        statusFilter,
        ...(cursor ? [cursor.startedAt, cursor.startedAt, cursor.groupId] : []),
        limit + 1,
      )
      .all<RunGroupRow>(),
  ]);

  const hasMoreRuns = runRows.results.length > limit;
  const requestedGroupRows = hasMoreRuns
    ? runRows.results.slice(0, limit)
    : runRows.results;
  const groupIds = requestedGroupRows.map((row) => String(row.id ?? ""));
  const pageTaskRows =
    groupIds.length > 0
      ? await env.DB.prepare(
          `${runSelectSql(
            `WHERE ${RUN_GROUP_KEY_SQL} IN (${groupIds.map(() => "?").join(", ")})`,
          )}
           ORDER BY started_at_ms ASC, task_key ASC`,
        )
          .bind(...groupIds)
          .all<RunRow>()
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
    let selectedRow = await env.DB.prepare(
      `${runGroupSelectSql(`WHERE ${RUN_GROUP_KEY_SQL} = ?`)}
       LIMIT 1`,
    )
      .bind(selectedGroupId)
      .first<RunGroupRow>();
    if (!selectedRow) {
      const directRun = await env.DB.prepare(
        `SELECT ${RUN_GROUP_KEY_SQL} AS id FROM scheduled_task_runs WHERE id = ? LIMIT 1`,
      )
        .bind(runId)
        .first<{ id: string }>();
      if (directRun?.id) {
        selectedRow = await env.DB.prepare(
          `${runGroupSelectSql(`WHERE ${RUN_GROUP_KEY_SQL} = ?`)}
           LIMIT 1`,
        )
          .bind(String(directRun.id))
          .first<RunGroupRow>();
      }
    }
    const detailGroupId = String(selectedRow?.id ?? selectedGroupId);
    selectedTaskRuns = selectedRow
      ? (
          await env.DB.prepare(
            `${runSelectSql(`WHERE ${RUN_GROUP_KEY_SQL} = ?`)}
             ORDER BY started_at_ms ASC, task_key ASC`,
          )
            .bind(detailGroupId)
            .all<RunRow>()
        ).results.map(mapRun)
      : [];
    if (selectedRow) {
      selectedRow.logsCount = await countRunLogs(
        env,
        selectedTaskRuns.map((run) => run.id),
      );
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
