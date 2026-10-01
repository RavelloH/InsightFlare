import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query } from "@/lib/db";
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
} from "@/lib/edge/admin/scheduled-tasks/query-plan";

interface SeedRun {
  readonly id: string;
  readonly invocationId: string;
  readonly taskKey: string;
  readonly triggerType: string;
  readonly status: string;
  readonly scheduledAt: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
}

const RUN_GROUP_KEY = `CASE
  WHEN scheduled_at_ms IS NOT NULL THEN
    trigger_type || ':' || scheduled_at_ms || ':' ||
    CAST(started_at_ms / 600000 AS INTEGER)
  ELSE invocation_id
END`;

function all<Row extends object>(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Row[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Row[];
}

function first<Row extends object>(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Row | undefined {
  return db
    .prepare(query.sql)
    .get(...((query.bindings ?? []) as SQLInputValue[])) as Row | undefined;
}

function seedRun(db: DatabaseSync, run: SeedRun): void {
  db.prepare(
    `INSERT INTO scheduled_task_runs
      (id, invocation_id, task_key, task_name, trigger_type, status,
       scheduled_at_ms, started_at_ms, finished_at_ms, duration_ms,
       scope_type, scope_id, summary_json, error_name, error_message,
       worker_version, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', NULL, '{}', NULL, NULL,
             NULL, 1700000000, 9999999999)`,
  ).run(
    run.id,
    run.invocationId,
    run.taskKey,
    run.taskKey,
    run.triggerType,
    run.status,
    run.scheduledAt,
    run.startedAt,
    run.finishedAt,
    run.durationMs,
  );
}

function legacyRunGroupPage(
  since30d: number,
  status: string,
  cursor: { readonly startedAt: number; readonly groupId: string } | null,
  limit: number,
) {
  const cursorClause = cursor
    ? "WHERE (startedAt < ? OR (startedAt = ? AND id > ?))"
    : "";
  return {
    sql: `
      WITH grouped AS (
        SELECT
          ${RUN_GROUP_KEY} AS id,
          MAX(trigger_type) AS triggerType,
          MIN(scheduled_at_ms) AS scheduledAt,
          MIN(started_at_ms) AS startedAt,
          CASE WHEN SUM(CASE WHEN finished_at_ms IS NULL THEN 1 ELSE 0 END) > 0
            THEN NULL ELSE MAX(finished_at_ms) END AS finishedAt,
          COUNT(*) AS taskCount,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount
        FROM scheduled_task_runs
        WHERE started_at_ms >= ?
        GROUP BY ${RUN_GROUP_KEY}
      ),
      normalized AS (
        SELECT *, CASE
          WHEN failedCount > 0 THEN 'failed'
          WHEN runningCount > 0 THEN 'running'
          WHEN partialCount > 0 THEN 'partial'
          WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
          ELSE 'success'
        END AS status FROM grouped
      ),
      filtered_groups AS (
        SELECT * FROM normalized WHERE (? = '' OR status = ?)
      ),
      page_groups AS (
        SELECT * FROM filtered_groups ${cursorClause}
        ORDER BY startedAt DESC, id ASC LIMIT ?
      ),
      page_runs AS (
        SELECT runs.id, ${RUN_GROUP_KEY.replaceAll(
          "scheduled_at_ms",
          "runs.scheduled_at_ms",
        )
          .replaceAll("trigger_type", "runs.trigger_type")
          .replaceAll("started_at_ms", "runs.started_at_ms")
          .replaceAll("invocation_id", "runs.invocation_id")} AS groupId
        FROM scheduled_task_runs runs
        INNER JOIN page_groups pg ON pg.id =
          ${RUN_GROUP_KEY.replaceAll("scheduled_at_ms", "runs.scheduled_at_ms")
            .replaceAll("trigger_type", "runs.trigger_type")
            .replaceAll("started_at_ms", "runs.started_at_ms")
            .replaceAll("invocation_id", "runs.invocation_id")}
      ),
      page_log_counts AS (
        SELECT pr.groupId, COUNT(*) AS logsCount
        FROM page_runs pr
        INNER JOIN scheduled_task_run_logs logs ON logs.run_id = pr.id
        GROUP BY pr.groupId
      )
      SELECT pg.*, COALESCE(plc.logsCount, 0) AS logsCount
      FROM page_groups pg
      LEFT JOIN page_log_counts plc ON plc.groupId = pg.id
      ORDER BY pg.startedAt DESC, pg.id ASC
    `,
    bindings: [
      since30d,
      status,
      status,
      ...(cursor ? [cursor.startedAt, cursor.startedAt, cursor.groupId] : []),
      limit + 1,
    ],
  };
}

function legacyRunLogsPage(
  runIds: readonly string[],
  limit: number,
  cursor: {
    readonly runStartedAt: number;
    readonly runId: string;
    readonly sequence: number;
    readonly logId: string;
  } | null,
) {
  const cursorClause = cursor
    ? `AND (runs.started_at_ms > ? OR (runs.started_at_ms = ? AND
       (logs.run_id > ? OR (logs.run_id = ? AND
       (logs.sequence > ? OR (logs.sequence = ? AND logs.id > ?))))))`
    : "";
  return {
    sql: `SELECT logs.id, logs.run_id AS runId, logs.task_key AS taskKey,
      logs.sequence, logs.level, logs.event, logs.message,
      logs.data_json AS dataJson, logs.created_at_ms AS createdAt,
      runs.started_at_ms AS runStartedAt
      FROM scheduled_task_run_logs logs
      INNER JOIN scheduled_task_runs runs ON runs.id = logs.run_id
      WHERE logs.run_id IN (${runIds.map(() => "?").join(", ")}) ${cursorClause}
      ORDER BY runs.started_at_ms ASC, logs.run_id ASC,
        logs.sequence ASC, logs.id ASC LIMIT ?`,
    bindings: [
      ...runIds,
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
    ],
  };
}

describe("scheduled task typed query plans", () => {
  it("matches the legacy grouped dashboard, detail and cursor read semantics", () => {
    const db = createMigratedDatabase();
    const now = 1_800_000_300_000;
    const since30d =
      Math.floor(now / 60_000) * 60_000 - 30 * 24 * 60 * 60 * 1000;
    const since24h = now - 24 * 60 * 60 * 1000;
    const staleBefore = now - 6 * 60 * 60 * 1000;
    const recentBucket =
      Math.trunc((now - 2 * 60 * 60 * 1000) / 600_000) * 600_000;
    const oldBoundary = since30d - 30_000;
    const newBoundary = since30d + 30_000;
    const seedRuns: SeedRun[] = [
      {
        id: "batch-success",
        invocationId: "batch-success",
        taskKey: "alpha",
        triggerType: "cron",
        status: "success",
        scheduledAt: 700,
        startedAt: recentBucket + 20_000,
        finishedAt: recentBucket + 40_000,
        durationMs: 20_000,
      },
      {
        id: "batch-failed",
        invocationId: "batch-failed",
        taskKey: "beta",
        triggerType: "cron",
        status: "failed",
        scheduledAt: 700,
        startedAt: recentBucket + 80_000,
        finishedAt: recentBucket + 90_000,
        durationMs: 10_000,
      },
      {
        id: "stale-running",
        invocationId: "shared-running-group",
        taskKey: "alpha",
        triggerType: "manual",
        status: "running",
        scheduledAt: null,
        startedAt: now - 8 * 60 * 60 * 1000,
        finishedAt: null,
        durationMs: null,
      },
      {
        id: "shared-partial",
        invocationId: "shared-running-group",
        taskKey: "gamma",
        triggerType: "manual",
        status: "partial",
        scheduledAt: null,
        startedAt: now - 4 * 60 * 60 * 1000,
        finishedAt: now - 3 * 60 * 60 * 1000,
        durationMs: 60 * 60 * 1000,
      },
      {
        id: "cutoff-old",
        invocationId: "cutoff-old",
        taskKey: "cutoff-task",
        triggerType: "daily",
        status: "success",
        scheduledAt: 900,
        startedAt: oldBoundary,
        finishedAt: oldBoundary + 1,
        durationMs: 1,
      },
      {
        id: "cutoff-new",
        invocationId: "cutoff-new",
        taskKey: "cutoff-task",
        triggerType: "daily",
        status: "success",
        scheduledAt: 900,
        startedAt: newBoundary,
        finishedAt: newBoundary + 1,
        durationMs: 1,
      },
      {
        id: "skip-and-success-a",
        invocationId: "skip-and-success",
        taskKey: "delta",
        triggerType: "manual",
        status: "skipped",
        scheduledAt: null,
        startedAt: now - 60_000,
        finishedAt: now - 59_000,
        durationMs: 1_000,
      },
      {
        id: "skip-and-success-b",
        invocationId: "skip-and-success",
        taskKey: "epsilon",
        triggerType: "manual",
        status: "success",
        scheduledAt: null,
        startedAt: now - 59_000,
        finishedAt: now - 58_000,
        durationMs: 1_000,
      },
    ];

    try {
      for (const run of seedRuns) seedRun(db, run);
      db.prepare(
        `INSERT INTO scheduled_task_schedule_state (task_key, enabled, next_run_at)
         VALUES ('alpha', 0, 1800000000)`,
      ).run();
      const logInsert = db.prepare(
        `INSERT INTO scheduled_task_run_logs
          (id, run_id, task_key, sequence, level, event, message, data_json,
           created_at_ms, expires_at)
         VALUES (?, ?, ?, ?, 'info', 'event', 'message', '{}', ?, 9999999999)`,
      );
      for (const [index, runId] of [
        "batch-success",
        "batch-failed",
        "stale-running",
        "cutoff-old",
        "cutoff-new",
      ].entries()) {
        logInsert.run(`log-${index}-a`, runId, runId, 1, now + index);
        logInsert.run(`log-${index}-b`, runId, runId, 2, now + index + 1);
      }

      const scheduleRows = all<Record<string, unknown>>(
        db,
        compileD1Query(buildScheduleStatesQuery()),
      );
      expect(scheduleRows).toEqual(
        db
          .prepare(
            `SELECT task_key AS taskKey, enabled, next_run_at AS nextRunAt
             FROM scheduled_task_schedule_state`,
          )
          .all(),
      );

      const health = first<Record<string, unknown>>(
        db,
        compileD1Query(buildHealthQuery(since24h, staleBefore)),
      );
      const legacyHealth = db
        .prepare(
          `WITH grouped AS (
             SELECT ${RUN_GROUP_KEY} AS id, MIN(started_at_ms) AS startedAt,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
               SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
               SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
               SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount,
               SUM(CASE WHEN status = 'running' AND started_at_ms < ? THEN 1 ELSE 0 END) AS staleRunningCount
             FROM scheduled_task_runs WHERE started_at_ms >= ?
             GROUP BY ${RUN_GROUP_KEY}
           ), normalized AS (
             SELECT *, CASE WHEN failedCount > 0 THEN 'failed'
               WHEN runningCount > 0 THEN 'running'
               WHEN partialCount > 0 THEN 'partial'
               WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
               ELSE 'success' END AS status FROM grouped
           )
           SELECT COUNT(*) AS totalRuns24h,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns24h,
             SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialRuns24h,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningRuns,
             SUM(CASE WHEN status = 'running' AND staleRunningCount > 0 THEN 1 ELSE 0 END) AS staleRunningRuns,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successRuns24h,
             MAX(startedAt) AS lastRunAt FROM normalized`,
        )
        .get(staleBefore, since24h);
      expect(health).toEqual(legacyHealth);

      const stats = all<Record<string, unknown>>(
        db,
        compileD1Query(buildTaskStatsQuery(since30d)),
      );
      const legacyStats = db
        .prepare(
          `SELECT task_key AS taskKey, COUNT(*) AS runs30d,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success30d,
             SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial30d,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed30d,
             SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped30d,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
             AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avgDurationMs
           FROM scheduled_task_runs WHERE started_at_ms >= ? GROUP BY task_key`,
        )
        .all(since30d);
      expect(stats).toEqual(legacyStats);

      const latest = all<Record<string, unknown>>(
        db,
        compileD1Query(buildLatestRunsQuery(since30d)),
      );
      const legacyLatest = db
        .prepare(
          `WITH ranked AS (
             SELECT id, invocation_id AS invocationId, task_key AS taskKey,
               task_name AS taskName, trigger_type AS triggerType, status,
               scheduled_at_ms AS scheduledAt, started_at_ms AS startedAt,
               finished_at_ms AS finishedAt, duration_ms AS durationMs,
               scope_type AS scopeType, scope_id AS scopeId,
               summary_json AS summaryJson, error_name AS errorName,
               error_message AS errorMessage, worker_version AS workerVersion,
               created_at AS createdAt, expires_at AS expiresAt,
               ROW_NUMBER() OVER (PARTITION BY task_key ORDER BY started_at_ms DESC) AS rn
             FROM scheduled_task_runs WHERE started_at_ms >= ?
           ) SELECT * FROM ranked WHERE rn = 1`,
        )
        .all(since30d)
        .map(({ rn: _rn, ...row }) => row);
      expect(latest).toEqual(legacyLatest);

      const compiledPage = compileD1Query(
        buildRunGroupsPageQuery({
          since30d,
          status: "",
          cursor: null,
          limit: 3,
        }),
      );
      const page = all<Record<string, unknown>>(db, compiledPage);
      const legacyPage = legacyRunGroupPage(since30d, "", null, 3);
      const pageExplain = db
        .prepare(`EXPLAIN QUERY PLAN ${compiledPage.sql}`)
        .all(...(compiledPage.bindings as SQLInputValue[])) as Array<{
        detail: string;
      }>;
      const legacyPageExplain = db
        .prepare(`EXPLAIN QUERY PLAN ${legacyPage.sql}`)
        .all(...(legacyPage.bindings as SQLInputValue[])) as Array<{
        detail: string;
      }>;
      const typedExplainText = pageExplain
        .map(({ detail }) => detail)
        .join(" ");
      const legacyExplainText = legacyPageExplain
        .map(({ detail }) => detail)
        .join(" ");
      expect(Buffer.byteLength(compiledPage.sql)).toBeLessThan(10_000);
      expect(compiledPage.bindings?.length ?? 0).toBeLessThan(100);
      expect(typedExplainText).toContain(
        "idx_scheduled_task_run_logs_run_sequence (run_id=?)",
      );
      expect(legacyExplainText).toContain(
        "idx_scheduled_task_run_logs_run_sequence",
      );
      expect(page).toEqual(
        db.prepare(legacyPage.sql).all(...legacyPage.bindings),
      );
      const cutoffGroup = page.find(
        (group) =>
          group.id === `daily:900:${Math.trunc(newBoundary / 600_000)}`,
      );
      expect(cutoffGroup).toMatchObject({ taskCount: 1, logsCount: 4 });

      const pageCursor = {
        startedAt: Number(page[1]?.startedAt),
        groupId: String(page[1]?.id),
      };
      const secondPage = all<Record<string, unknown>>(
        db,
        compileD1Query(
          buildRunGroupsPageQuery({
            since30d,
            status: "success",
            cursor: pageCursor,
            limit: 3,
          }),
        ),
      );
      const legacySecond = legacyRunGroupPage(
        since30d,
        "success",
        pageCursor,
        3,
      );
      expect(secondPage).toEqual(
        db.prepare(legacySecond.sql).all(...legacySecond.bindings),
      );

      const allGroups = db
        .prepare(
          `SELECT ${RUN_GROUP_KEY} AS id FROM scheduled_task_runs
           WHERE started_at_ms >= ? GROUP BY ${RUN_GROUP_KEY}
           ORDER BY MIN(started_at_ms) DESC, id ASC`,
        )
        .all(since30d) as Array<{ id: string }>;
      const groupIds = allGroups.map(({ id }) => id);
      expect(
        all<Record<string, unknown>>(
          db,
          compileD1Query(buildPageTaskRunsQuery(groupIds)),
        ),
      ).toEqual(
        db
          .prepare(
            `SELECT id, invocation_id AS invocationId, task_key AS taskKey,
              task_name AS taskName, trigger_type AS triggerType, status,
              scheduled_at_ms AS scheduledAt, started_at_ms AS startedAt,
              finished_at_ms AS finishedAt, duration_ms AS durationMs,
              scope_type AS scopeType, scope_id AS scopeId,
              summary_json AS summaryJson, error_name AS errorName,
              error_message AS errorMessage, worker_version AS workerVersion,
              created_at AS createdAt, expires_at AS expiresAt
             FROM scheduled_task_runs
             WHERE ${RUN_GROUP_KEY} IN (${groupIds.map(() => "?").join(", ")})
             ORDER BY started_at_ms ASC, task_key ASC`,
          )
          .all(...groupIds),
      );

      const selectedGroupId = "shared-running-group";
      const group = first<Record<string, unknown>>(
        db,
        compileD1Query(buildRunGroupByIdQuery(selectedGroupId)),
      );
      const legacyGroup = db
        .prepare(
          `WITH grouped AS (
             SELECT ${RUN_GROUP_KEY} AS id, MAX(trigger_type) AS triggerType,
               MIN(scheduled_at_ms) AS scheduledAt, MIN(started_at_ms) AS startedAt,
               CASE WHEN SUM(CASE WHEN finished_at_ms IS NULL THEN 1 ELSE 0 END) > 0
                 THEN NULL ELSE MAX(finished_at_ms) END AS finishedAt,
               COUNT(*) AS taskCount,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
               SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
               SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount,
               SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningCount
             FROM scheduled_task_runs GROUP BY ${RUN_GROUP_KEY}
           ), normalized AS (
             SELECT *, CASE WHEN failedCount > 0 THEN 'failed'
               WHEN runningCount > 0 THEN 'running'
               WHEN partialCount > 0 THEN 'partial'
               WHEN skippedCount > 0 AND successCount = 0 THEN 'skipped'
               ELSE 'success' END AS status FROM grouped
           ) SELECT *, 0 AS logsCount FROM normalized WHERE id = ? LIMIT 1`,
        )
        .get(selectedGroupId);
      expect(group).toEqual(legacyGroup);
      expect(
        first<Record<string, unknown>>(
          db,
          compileD1Query(buildRunGroupIdByRunIdQuery("stale-running")),
        ),
      ).toEqual({ id: selectedGroupId });
      expect(
        all<Record<string, unknown>>(
          db,
          compileD1Query(buildRunsByGroupIdQuery(selectedGroupId)),
        ),
      ).toEqual(
        db
          .prepare(
            `SELECT id, invocation_id AS invocationId, task_key AS taskKey,
              task_name AS taskName, trigger_type AS triggerType, status,
              scheduled_at_ms AS scheduledAt, started_at_ms AS startedAt,
              finished_at_ms AS finishedAt, duration_ms AS durationMs,
              scope_type AS scopeType, scope_id AS scopeId,
              summary_json AS summaryJson, error_name AS errorName,
              error_message AS errorMessage, worker_version AS workerVersion,
              created_at AS createdAt, expires_at AS expiresAt
             FROM scheduled_task_runs WHERE ${RUN_GROUP_KEY} = ?
             ORDER BY started_at_ms ASC, task_key ASC`,
          )
          .all(selectedGroupId),
      );

      const groupRunIds = ["stale-running", "shared-partial"];
      expect(
        first<Record<string, unknown>>(
          db,
          compileD1Query(buildCountRunLogsQuery(groupRunIds)),
        ),
      ).toEqual({ count: 2 });
      const allRunIds = seedRuns.map(({ id }) => id);
      const firstLogPage = all<Record<string, unknown>>(
        db,
        compileD1Query(buildRunLogsPageQuery(allRunIds, 2, null)),
      );
      const legacyLogs = legacyRunLogsPage(allRunIds, 2, null);
      expect(firstLogPage).toEqual(
        db.prepare(legacyLogs.sql).all(...legacyLogs.bindings),
      );
      const lastLog = firstLogPage[0]!;
      const logCursor = {
        runStartedAt: Number(lastLog.runStartedAt),
        runId: String(lastLog.runId),
        sequence: Number(lastLog.sequence),
        logId: String(lastLog.id),
      };
      const nextLogPage = all<Record<string, unknown>>(
        db,
        compileD1Query(buildRunLogsPageQuery(allRunIds, 2, logCursor)),
      );
      const legacyNextLogs = legacyRunLogsPage(allRunIds, 2, logCursor);
      expect(nextLogPage).toEqual(
        db.prepare(legacyNextLogs.sql).all(...legacyNextLogs.bindings),
      );

      const latestPlan = compileD1Query(buildLatestRunsQuery(since30d));
      const latestExplain = db
        .prepare(`EXPLAIN QUERY PLAN ${latestPlan.sql}`)
        .all(...(latestPlan.bindings as SQLInputValue[])) as Array<{
        detail: string;
      }>;
      expect(latestExplain.map(({ detail }) => detail).join(" ")).toContain(
        "idx_scheduled_task_runs_task_started",
      );
      const logPlan = compileD1Query(buildRunLogsPageQuery(allRunIds, 2, null));
      const logExplain = db
        .prepare(`EXPLAIN QUERY PLAN ${logPlan.sql}`)
        .all(...(logPlan.bindings as SQLInputValue[])) as Array<{
        detail: string;
      }>;
      expect(logExplain.map(({ detail }) => detail).join(" ")).toContain(
        "idx_scheduled_task_run_logs_run_sequence",
      );
    } finally {
      db.close();
    }
  });
});
