import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { handleScheduledTasksAdmin } from "@/lib/edge/admin-scheduled-tasks";
import { runScheduledTask } from "@/lib/edge/scheduled-task-runner";
import type { Env } from "@/lib/edge/types";
import type { ScheduledTasksData } from "@/lib/scheduled-tasks";

type Binding = string | number | null;
type Row = Record<string, unknown>;

class BoundStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Binding[],
  ) {}

  async all<T extends Row>(): Promise<{ results: T[] }> {
    return {
      results: this.db
        .prepare(this.sql)
        .all(...this.bindings)
        .map((row) => ({ ...row }) as T),
    };
  }

  async first<T extends Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.bindings);
    return row ? ({ ...row } as T) : null;
  }

  async run(): Promise<void> {
    this.db.prepare(this.sql).run(...this.bindings);
  }
}

class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) =>
        new BoundStatement(this.db, sql, bindings),
    };
  }

  async batch(statements: BoundStatement[]): Promise<void> {
    for (const statement of statements) {
      await statement.run();
    }
  }

  close(): void {
    this.db.close();
  }
}

function createEnv() {
  const d1 = new FakeD1Database();
  d1.db.exec(`
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      task_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_at_ms INTEGER,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      duration_ms INTEGER,
      scope_type TEXT NOT NULL DEFAULT 'system',
      scope_id TEXT,
      summary_json TEXT NOT NULL DEFAULT '{}',
      error_name TEXT,
      error_message TEXT,
      error_stack TEXT,
      worker_version TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE scheduled_task_run_logs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);
  return {
    d1,
    env: {
      DB: d1 as unknown as D1Database,
      INGEST_DO: {} as DurableObjectNamespace,
      DAILY_SALT_SECRET: "secret",
    } as Env,
  };
}

function scheduledGroupId(timestamp: number): string {
  return `cron:${timestamp}:${Math.trunc(timestamp / (10 * 60 * 1000))}`;
}

describe("scheduled task runner and admin API", () => {
  it("records successful runs and exposes logs through the admin API", async () => {
    const { env, d1 } = createEnv();

    await runScheduledTask(
      env,
      {
        key: "visit_hourly_rollup",
        name: "Hourly visit aggregation",
      },
      Date.UTC(2026, 5, 15, 4),
      async ({ logger }) => {
        await logger.info("unit_step", "Unit test step", { processed: 2 });
        return {
          status: "success",
          summary: { sitesProcessed: 2, rollupRowsWritten: 8 },
        };
      },
    );

    const response = await handleScheduledTasksAdmin(
      new Request("https://edge.test/api/private/admin/scheduled-tasks"),
      env,
      new URL("https://edge.test/api/private/admin/scheduled-tasks"),
      async () => ({ isAdmin: true }),
    );
    const payload = (await response.json()) as ScheduledTasksData;

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.runs[0]).toMatchObject({
      status: "success",
      taskCount: 1,
      subtaskCount: 2,
    });
    expect(payload.runs[0]?.runs[0]).toMatchObject({
      taskKey: "visit_hourly_rollup",
      status: "success",
    });
    expect(payload.runsMeta).toMatchObject({
      page: 1,
      pageSize: 50,
      returned: 1,
      hasMore: false,
      nextPage: null,
    });
    expect(payload.selectedRun?.summary).toMatchObject({
      sitesProcessed: 2,
      rollupRowsWritten: 8,
    });
    expect(payload.logs.map((log) => log.event)).toContain("unit_step");
    const rollupTask = payload.tasks.find(
      (task) => task.key === "visit_hourly_rollup",
    );
    expect(rollupTask?.lastRun?.status).toBe("success");
    d1.close();
  });

  it("keeps an execution-level skipped run without detail logs", async () => {
    const { env, d1 } = createEnv();

    await runScheduledTask(
      env,
      { key: "visit_hourly_rollup", name: "Hourly visit aggregation" },
      Date.UTC(2026, 5, 15, 4),
      async () => ({
        status: "skipped",
        summary: { candidateSites: 0, sitesProcessed: 0 },
      }),
    );

    const response = await handleScheduledTasksAdmin(
      new Request("https://edge.test/api/private/admin/scheduled-tasks"),
      env,
      new URL("https://edge.test/api/private/admin/scheduled-tasks"),
      async () => ({ isAdmin: true }),
    );
    const payload = (await response.json()) as ScheduledTasksData;

    expect(payload.runs[0]).toMatchObject({
      status: "skipped",
      taskCount: 1,
      successCount: 0,
      skippedCount: 1,
      logsCount: 0,
    });
    expect(payload.logs).toEqual([]);
    expect(payload.runs[0]?.runs[0]?.status).toBe("skipped");
    d1.close();
  });

  it("paginates runs and selects run details outside the current page", async () => {
    const { env, d1 } = createEnv();
    const now = Date.now();
    const expiresAt = Math.floor((now + 30 * 24 * 60 * 60 * 1000) / 1000);

    for (let index = 0; index < 12; index += 1) {
      d1.db
        .prepare(
          `
            INSERT INTO scheduled_task_runs (
              id,
              invocation_id,
              task_key,
              task_name,
              trigger_type,
              status,
              scheduled_at_ms,
              started_at_ms,
              finished_at_ms,
              duration_ms,
              summary_json,
              created_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          `run-${index}`,
          `invocation-${index}`,
          "visit_hourly_rollup",
          "Hourly visit aggregation",
          "cron",
          "success",
          now - index * 60_000,
          now - index * 60_000,
          now - index * 60_000 + 250,
          250,
          JSON.stringify({ rollupRowsWritten: index }),
          Math.floor(now / 1000),
          expiresAt,
        );
    }

    const url = new URL(
      "https://edge.test/api/private/admin/scheduled-tasks?page=2&pageSize=5&runId=run-10",
    );
    const response = await handleScheduledTasksAdmin(
      new Request(url),
      env,
      url,
      async () => ({ isAdmin: true }),
    );
    const payload = (await response.json()) as ScheduledTasksData;

    expect(response.status).toBe(200);
    expect(payload.runs.map((run) => run.id)).toEqual(
      [5, 6, 7, 8, 9].map((index) => scheduledGroupId(now - index * 60_000)),
    );
    expect(payload.runsMeta).toEqual({
      page: 2,
      pageSize: 5,
      returned: 5,
      hasMore: true,
      nextPage: 3,
    });
    expect(payload.selectedRun?.id).toBe(scheduledGroupId(now - 10 * 60_000));
    expect(payload.selectedRun?.runs[0]?.id).toBe("run-10");
    d1.close();
  });

  it("counts skipped runs independently in run groups", async () => {
    const { env, d1 } = createEnv();
    const now = Date.now();
    const scheduledAt = now - 60_000;
    const expiresAt = Math.floor((now + 30 * 24 * 60 * 60 * 1000) / 1000);

    for (const [index, status] of ["success", "skipped"].entries()) {
      d1.db
        .prepare(
          `
            INSERT INTO scheduled_task_runs (
              id,
              invocation_id,
              task_key,
              task_name,
              trigger_type,
              status,
              scheduled_at_ms,
              started_at_ms,
              finished_at_ms,
              duration_ms,
              summary_json,
              created_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          `run-${index}`,
          `invocation-${index}`,
          index === 0 ? "notification_tick" : "visit_hourly_rollup",
          index === 0 ? "Notification dispatch" : "Hourly visit aggregation",
          "cron",
          status,
          scheduledAt,
          scheduledAt + index * 1_000,
          scheduledAt + index * 1_000 + 250,
          250,
          "{}",
          Math.floor(now / 1000),
          expiresAt,
        );
    }

    const response = await handleScheduledTasksAdmin(
      new Request("https://edge.test/api/private/admin/scheduled-tasks"),
      env,
      new URL("https://edge.test/api/private/admin/scheduled-tasks"),
      async () => ({ isAdmin: true }),
    );
    const payload = (await response.json()) as ScheduledTasksData;

    expect(response.status).toBe(200);
    expect(payload.runs[0]).toMatchObject({
      status: "success",
      taskCount: 2,
      successCount: 1,
      skippedCount: 1,
    });
    expect(payload.health.totalRuns24h).toBe(1);
    expect(payload.health.successRate24h).toBe(1);
    d1.close();
  });

  it("marks failed runs when the handler throws", async () => {
    const { env, d1 } = createEnv();

    await expect(
      runScheduledTask(
        env,
        {
          key: "visit_hourly_rollup",
          name: "Hourly visit aggregation",
        },
        Date.UTC(2026, 5, 15, 4),
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const row = d1.db
      .prepare(
        "SELECT status, error_name AS errorName, error_message AS errorMessage FROM scheduled_task_runs",
      )
      .get() as Row;
    expect(row).toMatchObject({
      status: "failed",
      errorName: "Error",
      errorMessage: "boom",
    });
    d1.close();
  });
});
