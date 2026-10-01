import type { SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/scheduled-tasks", () => ({
  SCHEDULED_TASK_LOG_RETENTION_DAYS: 30,
}));
vi.mock("@/lib/edge/admin/response", () => ({
  bad: vi.fn(
    (msg: string, _code?: string, _req?: Request) =>
      new Response(JSON.stringify({ ok: false, error: msg }), { status: 400 }),
  ),
  forb: vi.fn(
    (msg: string, _code?: string, _req?: Request) =>
      new Response(JSON.stringify({ ok: false, error: msg }), { status: 403 }),
  ),
  jsonResponseFor: vi.fn(
    (_req: Request, data: unknown) =>
      new Response(JSON.stringify(data), { status: 200 }),
  ),
  na: vi.fn(
    (_req: Request) =>
      new Response(JSON.stringify({ ok: false, error: "not allowed" }), {
        status: 405,
      }),
  ),
  parseJson: vi.fn(async (req: Request) => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }),
  bool: vi.fn(
    (value: unknown) => value === true || value === "true" || value === 1,
  ),
}));
vi.mock("@/lib/edge/scheduled-tasks/registry", () => ({
  SCHEDULED_TASKS: [
    {
      key: "hourly-rollup",
      name: "Hourly Rollup",
      description: "Aggregates data",
      schedule: "0 * * * *",
      trigger: "cron",
      enabled: true,
    },
    {
      key: "cleanup",
      name: "Cleanup",
      description: "Cleans up",
      schedule: "0 0 * * *",
      trigger: "cron",
      enabled: false,
    },
  ],
}));
import { handleScheduledTasksAdmin } from "@/lib/edge/admin/scheduled-tasks/handler";
interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}
function statement(
  input: {
    first?: unknown;
    all?: Record<string, unknown>[];
    run?: unknown;
  } = {},
): MockStatement {
  const stmt = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  } satisfies MockStatement;

  stmt.first.mockResolvedValue("first" in input ? input.first : null);
  stmt.all.mockResolvedValue({ results: "all" in input ? input.all : [] });
  stmt.run.mockResolvedValue("run" in input ? input.run : undefined);
  return stmt;
}
function createEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: {
      prepare: vi.fn(() => statement()),
      ...overrides,
    },
    DAILY_SALT_SECRET: "test-pagination-secret",
  } as unknown as Env;
}
function makeUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`https://app.test${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return url;
}
const adminActor = { isAdmin: true };
const nonAdminActor = { isAdmin: false };
async function resolveAdmin() {
  return adminActor;
}
async function resolveNonAdmin() {
  return nonAdminActor;
}
async function resolveAsResponse() {
  return new Response("unauthorized", { status: 401 });
}
describe("handleScheduledTasksAdmin", () => {
  it("uses cursor pagination instead of removed page-number parameters", async () => {
    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks?limit=100",
    );
    const env = createEnv();
    const url = new URL(req.url);

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );

    expect(response.status).toBe(200);
    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it("returns forbidden for non-admin actor", async () => {
    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const env = createEnv();
    const url = makeUrl("/api/private/admin/scheduled-tasks");

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveNonAdmin,
    );
    expect(response.status).toBe(403);
  });

  it("returns actor response when resolver returns a Response", async () => {
    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const env = createEnv();
    const url = makeUrl("/api/private/admin/scheduled-tasks");

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAsResponse,
    );
    expect(response.status).toBe(401);
  });

  it("returns method not allowed for non-GET methods", async () => {
    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
      { method: "POST" },
    );
    const env = createEnv();
    const url = makeUrl("/api/private/admin/scheduled-tasks");

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    expect(response.status).toBe(405);
  });

  it("returns scheduled tasks data for admin GET request", async () => {
    const healthRow = {
      totalRuns24h: 10,
      failedRuns24h: 1,
      partialRuns24h: 0,
      runningRuns: 2,
      staleRunningRuns: 0,
      successRuns24h: 7,
      lastRunAt: 1000,
    };
    const statsRows = [
      {
        taskKey: "hourly-rollup",
        runs30d: 100,
        success30d: 90,
        partial30d: 5,
        failed30d: 3,
        skipped30d: 2,
        running: 0,
        avgDurationMs: 500,
      },
    ];
    const latestRows = [
      {
        id: "run-1",
        invocationId: "inv-1",
        taskKey: "hourly-rollup",
        taskName: "Hourly Rollup",
        triggerType: "cron",
        status: "success",
        scheduledAt: 900,
        startedAt: 1000,
        finishedAt: 1500,
        durationMs: 500,
        scopeType: "system",
        scopeId: null,
        summaryJson: "{}",
        errorName: null,
        errorMessage: null,
        workerVersion: null,
        createdAt: 1000,
        expiresAt: 2000,
      },
    ];

    const healthStmt = statement({ first: healthRow });
    const statsStmt = statement({ all: statsRows });
    const latestStmt = statement({ all: latestRows });
    const runsStmt = statement({ all: [] });
    const scheduleStatesStmt = statement({
      all: [{ taskKey: "cleanup", enabled: 1, nextRunAt: 2000 }],
    });

    const env = { DB: { prepare: vi.fn(() => healthStmt) } } as unknown as Env;
    let prepareCallCount = 0;
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const stmts = [
        healthStmt,
        statsStmt,
        latestStmt,
        runsStmt,
        scheduleStatesStmt,
      ];
      return stmts[prepareCallCount++] ?? statement();
    });

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const url = makeUrl("/api/private/admin/scheduled-tasks");

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].key).toBe("hourly-rollup");
    expect(body.tasks[0].runs30d).toBe(100);
    expect(body.health.totalRuns24h).toBe(10);
    expect(body.tasks[1]).toMatchObject({
      key: "cleanup",
      enabled: true,
      nextRunAt: 2_000_000,
    });
  });

  it("updates a known task through the admin PATCH path", async () => {
    const updateStmt = statement();
    const healthStmt = statement({ first: {} });
    const statsStmt = statement({ all: [] });
    const latestStmt = statement({ all: [] });
    const runsStmt = statement({ all: [] });
    const scheduleStatesStmt = statement({ all: [] });
    const retentionStmt = statement({ first: null });
    let prepareCallCount = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => {
          const stmts = [
            updateStmt,
            healthStmt,
            statsStmt,
            latestStmt,
            runsStmt,
            scheduleStatesStmt,
            retentionStmt,
          ];
          return stmts[prepareCallCount++] ?? statement();
        }),
      },
      DAILY_SALT_SECRET: "test-pagination-secret",
    } as unknown as Env;

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskKey: "cleanup", enabled: true }),
      },
    );
    const response = await handleScheduledTasksAdmin(
      req,
      env,
      new URL(req.url),
      resolveAdmin,
    );

    expect(response.status).toBe(200);
    expect(updateStmt.run).toHaveBeenCalledOnce();
    expect(updateStmt.bind).toHaveBeenCalledWith(1, "cleanup");
  });

  it("handles pagination with hasMoreRuns", async () => {
    const runRows = Array.from({ length: 51 }, (_, i) => ({
      id: `run-${i}`,
      invocationId: `inv-${i}`,
      taskKey: "hourly-rollup",
      taskName: "Hourly Rollup",
      triggerType: "cron",
      status: "success",
      scheduledAt: null,
      startedAt: 1000 + i,
      finishedAt: 1500 + i,
      durationMs: 500,
      scopeType: "system",
      scopeId: null,
      summaryJson: "{}",
      errorName: null,
      errorMessage: null,
      workerVersion: null,
      createdAt: 1000,
      expiresAt: 2000,
    }));

    const healthStmt = statement({ first: {} });
    const statsStmt = statement({ all: [] });
    const latestStmt = statement({ all: [] });
    const runsStmt = statement({ all: runRows });

    let prepareCallCount = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => {
          const stmts = [healthStmt, statsStmt, latestStmt, runsStmt];
          return stmts[prepareCallCount++] ?? statement();
        }),
      },
      DAILY_SALT_SECRET: "test-pagination-secret",
    } as unknown as Env;

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const url = makeUrl("/api/private/admin/scheduled-tasks", {
      limit: "50",
    });

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    const body = (await response.json()) as any;
    expect(body.runs.items).toHaveLength(50);
    expect(body.runs.pagination.hasMore).toBe(true);
    expect(body.runs.pagination.nextCursor).toEqual(expect.any(String));
    const runHistorySql = (env.DB.prepare as ReturnType<typeof vi.fn>).mock
      .calls[3]?.[0] as string;
    expect(runHistorySql).toContain("GROUP BY");
    expect(runHistorySql).not.toContain("GROUP BY id");
  });

  it("paginates selected run logs with the complete cursor key", async () => {
    const selectedRun = {
      id: "run-1",
      invocationId: "inv-1",
      taskKey: "hourly-rollup",
      taskName: "Hourly Rollup",
      triggerType: "cron",
      status: "success",
      scheduledAt: null,
      startedAt: 1000,
      finishedAt: 1500,
      durationMs: 500,
      scopeType: "system",
      scopeId: null,
      summaryJson: "{}",
      errorName: null,
      errorMessage: null,
      workerVersion: null,
      createdAt: 1000,
      expiresAt: 2000,
    };
    const selectedGroup = {
      id: "inv-1",
      triggerType: "cron",
      status: "success",
      scheduledAt: null,
      startedAt: 1000,
      finishedAt: 1500,
      taskCount: 1,
      successCount: 1,
      partialCount: 0,
      failedCount: 0,
      skippedCount: 0,
      runningCount: 0,
      logsCount: 2,
    };
    const logRows = [
      {
        id: "log-1",
        runId: "run-1",
        taskKey: "hourly-rollup",
        sequence: 1,
        level: "info",
        event: "started",
        message: "started",
        dataJson: "{}",
        createdAt: 1001,
        runStartedAt: 1000,
      },
      {
        id: "log-2",
        runId: "run-1",
        taskKey: "hourly-rollup",
        sequence: 2,
        level: "info",
        event: "finished",
        message: "finished",
        dataJson: "{}",
        createdAt: 1002,
        runStartedAt: 1000,
      },
    ];

    function createLogEnv(afterCursor = false) {
      const statements = [
        statement({ first: {} }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ first: selectedGroup }),
        statement({ all: [selectedRun] }),
        statement({ first: { count: 2 } }),
        statement({ all: afterCursor ? [logRows[1]!] : logRows }),
        statement({ all: [] }),
        statement({ first: null }),
      ];
      let index = 0;
      return {
        DB: {
          prepare: vi.fn(() => statements[index++] ?? statement()),
        },
        DAILY_SALT_SECRET: "test-pagination-secret",
      } as unknown as Env;
    }

    const firstRequest = new Request(
      "https://app.test/api/private/admin/scheduled-tasks?runId=run-1&logLimit=1",
    );
    const firstResponse = await handleScheduledTasksAdmin(
      firstRequest,
      createLogEnv(),
      new URL(firstRequest.url),
      resolveAdmin,
    );
    const firstBody = (await firstResponse.json()) as any;
    expect(firstBody.logs.items).toHaveLength(1);
    expect(firstBody.logs.pagination).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });

    const secondUrl = new URL(firstRequest.url);
    secondUrl.searchParams.set(
      "logCursor",
      firstBody.logs.pagination.nextCursor,
    );
    const secondResponse = await handleScheduledTasksAdmin(
      new Request(secondUrl),
      createLogEnv(true),
      secondUrl,
      resolveAdmin,
    );
    const secondBody = (await secondResponse.json()) as any;
    expect(secondResponse.status).toBe(200);
    expect(secondBody.logs.items).toMatchObject([{ id: "log-2", sequence: 2 }]);
    expect(secondBody.logs.pagination).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
  });

  it("filters by runId when provided", async () => {
    const selectedRun = {
      id: "specific-run",
      invocationId: "inv-1",
      taskKey: "hourly-rollup",
      taskName: "Hourly Rollup",
      triggerType: "cron",
      status: "success",
      scheduledAt: null,
      startedAt: 1000,
      finishedAt: 1500,
      durationMs: 500,
      scopeType: "system",
      scopeId: null,
      summaryJson: "{}",
      errorName: null,
      errorMessage: null,
      workerVersion: null,
      createdAt: 1000,
      expiresAt: 2000,
    };

    const healthStmt = statement({ first: {} });
    const statsStmt = statement({ all: [] });
    const latestStmt = statement({ all: [] });
    const runsStmt = statement({ all: [] });
    const selectedStmt = statement({ first: selectedRun });
    const logsStmt = statement({ all: [] });

    let prepareCallCount = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => {
          const stmts = [
            healthStmt,
            statsStmt,
            latestStmt,
            runsStmt,
            selectedStmt,
            logsStmt,
          ];
          return stmts[prepareCallCount++] ?? statement();
        }),
      },
    } as unknown as Env;

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const url = makeUrl("/api/private/admin/scheduled-tasks", {
      runId: "specific-run",
    });

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    const body = (await response.json()) as any;
    expect(body.selectedRun.id).toBe("specific-run");
  });

  it("returns null selectedRun when no runs exist", async () => {
    const healthStmt = statement({ first: {} });
    const statsStmt = statement({ all: [] });
    const latestStmt = statement({ all: [] });
    const runsStmt = statement({ all: [] });

    let prepareCallCount = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => {
          const stmts = [healthStmt, statsStmt, latestStmt, runsStmt];
          return stmts[prepareCallCount++] ?? statement();
        }),
      },
    } as unknown as Env;

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const url = makeUrl("/api/private/admin/scheduled-tasks");

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    const body = (await response.json()) as any;
    expect(body.selectedRun).toBeNull();
  });

  it("filters by taskKey and status", async () => {
    const healthStmt = statement({ first: {} });
    const statsStmt = statement({ all: [] });
    const latestStmt = statement({ all: [] });
    const runsStmt = statement({ all: [] });

    let prepareCallCount = 0;
    const env = {
      DB: {
        prepare: vi.fn(() => {
          const stmts = [healthStmt, statsStmt, latestStmt, runsStmt];
          return stmts[prepareCallCount++] ?? statement();
        }),
      },
    } as unknown as Env;

    const req = new Request(
      "https://app.test/api/private/admin/scheduled-tasks",
    );
    const url = makeUrl("/api/private/admin/scheduled-tasks", {
      taskKey: "cleanup",
      status: "failed",
    });

    const response = await handleScheduledTasksAdmin(
      req,
      env,
      url,
      resolveAdmin,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("resolves a selected run id through the typed group fallback on SQLite", async () => {
    const database = createMigratedDatabase();
    const now = 1_800_000_300_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const trace = {
      preparedSql: [] as string[],
      bindings: [] as SQLInputValue[][],
    };
    try {
      database
        .prepare(
          `INSERT INTO scheduled_task_runs
            (id, invocation_id, task_key, task_name, trigger_type, status,
             scheduled_at_ms, started_at_ms, finished_at_ms, duration_ms,
             scope_type, scope_id, summary_json, expires_at)
           VALUES ('selected-run-id', 'selected-group-id', 'hourly-rollup',
             'Hourly Rollup', 'manual', 'success', NULL, ?, ?, 25,
             'system', NULL, '{}', 9999999999)`,
        )
        .run(now - 50, now - 25);
      database
        .prepare(
          `INSERT INTO scheduled_task_run_logs
            (id, run_id, task_key, sequence, level, event, message,
             data_json, created_at_ms, expires_at)
           VALUES ('selected-log', 'selected-run-id', 'hourly-rollup', 1,
             'info', 'completed', 'done', '{}', ?, 9999999999)`,
        )
        .run(now - 20);
      const env = {
        DB: createSqliteD1Database(database, trace),
        DAILY_SALT_SECRET: "test-pagination-secret",
      } as unknown as Env;
      const request = new Request(
        "https://app.test/api/private/admin/scheduled-tasks?runId=selected-run-id",
      );
      const response = await handleScheduledTasksAdmin(
        request,
        env,
        new URL(request.url),
        resolveAdmin,
      );
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.selectedRun).toMatchObject({
        id: "selected-group-id",
        taskCount: 1,
        logsCount: 1,
        runs: [{ id: "selected-run-id" }],
      });
      expect(body.logs.items).toMatchObject([{ id: "selected-log" }]);
      expect(trace.preparedSql).toHaveLength(13);
    } finally {
      nowSpy.mockRestore();
      database.close();
    }
  });

  it("keeps scheduled log count and page reads on 100-id chunks", async () => {
    const database = createMigratedDatabase();
    const now = 1_800_000_300_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const trace = {
      preparedSql: [] as string[],
      bindings: [] as SQLInputValue[][],
    };
    try {
      const insertRun = database.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           scheduled_at_ms, started_at_ms, finished_at_ms, duration_ms,
           scope_type, summary_json, expires_at)
         VALUES (?, 'hundred-run-group', 'hourly-rollup', 'Hourly Rollup',
           'manual', 'success', NULL, ?, ?, 1, 'system', '{}', 9999999999)`,
      );
      const insertLog = database.prepare(
        `INSERT INTO scheduled_task_run_logs
          (id, run_id, task_key, sequence, level, event, message, data_json,
           created_at_ms, expires_at)
         VALUES (?, ?, 'hourly-rollup', 1, 'info', 'completed', 'done',
           '{}', ?, 9999999999)`,
      );
      for (let index = 0; index < 101; index++) {
        const runId = `hundred-run-${String(index).padStart(3, "0")}`;
        insertRun.run(runId, now - index - 1, now - index);
        insertLog.run(`hundred-log-${index}`, runId, now + index);
      }

      const env = {
        DB: createSqliteD1Database(database, trace),
        DAILY_SALT_SECRET: "test-pagination-secret",
      } as unknown as Env;
      const request = new Request(
        "https://app.test/api/private/admin/scheduled-tasks?runGroupId=hundred-run-group",
      );
      const response = await handleScheduledTasksAdmin(
        request,
        env,
        new URL(request.url),
        resolveAdmin,
      );
      const body = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(body.selectedRun.logsCount).toBe(101);
      expect(body.logs.items).toHaveLength(101);
      const queries = trace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trace.bindings[index] ?? [],
      }));
      const countChunks = queries
        .filter(
          ({ sql }) =>
            sql.includes("COUNT(*)") &&
            sql.includes('"scheduled_task_run_logs"') &&
            sql.includes(" IN ("),
        )
        .map(({ bindings }) => bindings.length);
      const logPageQueries = queries.filter(
        ({ sql }) =>
          sql.includes('"runStartedAt"') &&
          sql.includes('"scheduled_task_run_logs"') &&
          sql.includes('"scheduled_task_runs"') &&
          sql.includes(" ORDER BY "),
      );
      expect(countChunks).toEqual([100, 1]);
      expect(logPageQueries.map(({ bindings }) => bindings.length)).toEqual([
        2, 2,
      ]);
      expect(logPageQueries[0]?.sql).toContain("json_each(?)");
      expect(logPageQueries[1]?.sql).not.toContain("json_each(?)");
    } finally {
      nowSpy.mockRestore();
      database.close();
    }
  });
});
