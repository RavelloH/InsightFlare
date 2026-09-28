import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/scheduled-tasks", () => ({
  SCHEDULED_TASK_LOG_RETENTION_DAYS: 30,
}));
const { runScheduledTask } = await import("@/lib/edge/scheduled-tasks/runner");
interface MockStatement {
  sql: string;
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
    runReject?: unknown;
  } = {},
): MockStatement {
  const stmt = {
    sql: "",
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  } satisfies MockStatement;

  stmt.first.mockResolvedValue("first" in input ? input.first : null);

  if ("runReject" in input) {
    stmt.run.mockRejectedValue(input.runReject);
  } else {
    stmt.run.mockResolvedValue("run" in input ? input.run : undefined);
  }

  stmt.all.mockResolvedValue({ results: "all" in input ? input.all : [] });
  return stmt;
}
interface InstrumentedEnv extends Env {
  preparedSql: string[];
  batches: number[];
}
function createEnv(statements: MockStatement[] = []): InstrumentedEnv {
  let callIndex = 0;
  const preparedSql: string[] = [];
  const batches: number[] = [];
  const prepare = vi.fn((sql: string) => {
    const prepared = statements[callIndex++] ?? statement();
    prepared.sql = sql;
    preparedSql.push(sql);
    return prepared;
  });
  const batch = vi.fn(async (batchStatements: MockStatement[]) => {
    batches.push(batchStatements.length);
    for (const batchStatement of batchStatements) {
      await (batchStatement.run as unknown as () => Promise<unknown>)();
    }
    return batchStatements.map(() => ({ success: true, meta: { changes: 1 } }));
  });
  return {
    DB: { prepare, batch },
    preparedSql,
    batches,
  } as unknown as InstrumentedEnv;
}
const definition = {
  key: "test-task",
  name: "Test Task",
  triggerType: "cron" as const,
  scopeType: "system",
};
describe("runScheduledTask", () => {
  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () =>
        `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs handler to completion and updates run status to success", async () => {
    const configStmt = statement({ first: null });
    const insertStmt = statement({ run: undefined });
    const logStartStmt = statement({ run: undefined });
    const logFinishStmt = statement({ run: undefined });
    const updateStmt = statement({ run: undefined });

    const env = createEnv([
      configStmt,
      insertStmt,
      logStartStmt,
      logFinishStmt,
      updateStmt,
    ]);
    const handler = vi
      .fn()
      .mockResolvedValue({ status: "success", summary: { count: 42 } });

    await runScheduledTask(env, definition, 1000, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].scheduledTime).toBe(1000);
    expect(handler.mock.calls[0][0].runId).toBe("uuid-1");
    expect(updateStmt.run).toHaveBeenCalled();
    expect(env.batches).toEqual([2]);
    expect(
      env.preparedSql.map(
        (sql) => sql.match(/(?:INSERT INTO|UPDATE) ([^ ]+)/)?.[1],
      ),
    ).toEqual([
      undefined,
      '"scheduled_task_runs"',
      '"scheduled_task_run_logs"',
      '"scheduled_task_run_logs"',
      '"scheduled_task_runs"',
    ]);
    expect(env.preparedSql[1]).toContain(
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    expect(insertStmt.bind.mock.calls[0]).toEqual([
      "uuid-1",
      "uuid-2",
      "test-task",
      "Test Task",
      "cron",
      "running",
      1000,
      expect.any(Number),
      "system",
      null,
      "{}",
      null,
      expect.any(Number),
    ]);
    expect(updateStmt.bind.mock.calls[0]?.slice(0, 7)).toEqual([
      "success",
      expect.any(Number),
      expect.any(Number),
      JSON.stringify({ count: 42 }),
      null,
      null,
      null,
    ]);
  });

  it("defaults to success when handler returns void", async () => {
    const stmts = Array.from({ length: 6 }, () => statement());
    const env = createEnv(stmts);
    const handler = vi.fn().mockResolvedValue(undefined);

    await runScheduledTask(env, definition, 1000, handler);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handles custom partial outcome", async () => {
    const stmts = Array.from({ length: 6 }, () => statement());
    const env = createEnv(stmts);
    const handler = vi
      .fn()
      .mockResolvedValue({ status: "partial", summary: { processed: 5 } });

    await runScheduledTask(env, definition, 1000, handler);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handles custom skipped outcome", async () => {
    const stmts = Array.from({ length: 6 }, () => statement());
    const env = createEnv(stmts);
    const handler = vi.fn().mockResolvedValue({ status: "skipped" });

    await runScheduledTask(env, definition, 1000, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(env.batches).toEqual([]);
    expect(env.preparedSql).toHaveLength(3);
    expect(env.preparedSql[2]).toContain('UPDATE "scheduled_task_runs"');
  });

  it("sets scheduledAt to null when scheduledTime is undefined", async () => {
    const stmts = Array.from({ length: 6 }, () => statement());
    const env = createEnv(stmts);
    const handler = vi.fn().mockResolvedValue(undefined);

    await runScheduledTask(env, definition, undefined, handler);

    expect(handler.mock.calls[0][0].scheduledTime).toBeNull();
  });

  it("preserves cron scheduledTime for run history grouping", async () => {
    const configStmt = statement({ first: null });
    const insertStmt = statement();
    const remainingStmts = Array.from({ length: 3 }, () => statement());
    const env = createEnv([configStmt, insertStmt, ...remainingStmts]);
    const handler = vi.fn().mockResolvedValue(undefined);
    const delayedScheduledTime = Date.UTC(2026, 0, 1, 8, 4, 30);

    await runScheduledTask(env, definition, delayedScheduledTime, handler);

    expect(handler.mock.calls[0][0].scheduledTime).toBe(delayedScheduledTime);
    expect(insertStmt.bind).toHaveBeenCalledWith(
      "uuid-1",
      "uuid-2",
      definition.key,
      definition.name,
      "cron",
      "running",
      delayedScheduledTime,
      expect.any(Number),
      definition.scopeType,
      null,
      "{}",
      null,
      expect.any(Number),
    );
    expect(env.batches).toEqual([2]);
  });

  it("re-throws handler errors after recording failure", async () => {
    const configStmt = statement({ first: null });
    const insertStmt = statement();
    const logStartStmt = statement();
    const logErrorStmt = statement();
    const updateStmt = statement();

    const env = createEnv([
      configStmt,
      insertStmt,
      logStartStmt,
      logErrorStmt,
      updateStmt,
    ]);
    const error = new Error("task failed");
    const handler = vi.fn().mockRejectedValue(error);

    await expect(
      runScheduledTask(env, definition, 1000, handler),
    ).rejects.toThrow("task failed");
    expect(updateStmt.run).toHaveBeenCalled();
    expect(
      env.preparedSql.map(
        (sql) => sql.match(/(?:INSERT INTO|UPDATE) ([^ ]+)/)?.[1],
      ),
    ).toEqual([
      undefined,
      '"scheduled_task_runs"',
      '"scheduled_task_run_logs"',
      '"scheduled_task_run_logs"',
      '"scheduled_task_runs"',
    ]);
    expect(updateStmt.bind.mock.calls[0]).toEqual([
      "failed",
      expect.any(Number),
      expect.any(Number),
      "{}",
      "Error",
      "task failed",
      expect.any(String),
      "uuid-1",
    ]);
  });

  it("handles non-Error thrown values", async () => {
    const stmts = Array.from({ length: 6 }, () => statement());
    const env = createEnv(stmts);
    const handler = vi.fn().mockRejectedValue("string error");

    await expect(runScheduledTask(env, definition, 1000, handler)).rejects.toBe(
      "string error",
    );
  });

  it("continues when DB writes fail during bestEffortRun", async () => {
    const configStmt = statement({ first: null });
    const insertStmt = statement({ runReject: new Error("db down") });
    const logStmt = statement({ runReject: new Error("db down") });
    const updateStmt = statement({ runReject: new Error("db down") });

    const env = createEnv([
      configStmt,
      insertStmt,
      logStmt,
      logStmt,
      updateStmt,
    ]);
    const handler = vi.fn().mockResolvedValue(undefined);

    // Should not throw even though DB writes fail
    await runScheduledTask(env, definition, 1000, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(env.batches).toEqual([2]);
  });

  it("keeps the fixed 50-entry batch boundaries for buffered logs", async () => {
    const env = createEnv();
    const handler = vi.fn(
      async ({
        logger,
      }: {
        logger: { info: (event: string, message: string) => Promise<void> };
      }) => {
        for (let index = 0; index < 118; index += 1) {
          await logger.info("item", `log ${index}`);
        }
        return { status: "success" as const };
      },
    );

    await runScheduledTask(env, definition, 1000, handler);

    expect(env.batches).toEqual([50, 50, 20]);
    expect(
      env.preparedSql.filter((sql) =>
        sql.includes('INSERT INTO "scheduled_task_run_logs"'),
      ),
    ).toHaveLength(120);
  });

  it("mirrors stable task events without persisting operator-facing data", async () => {
    const env = createEnv(Array.from({ length: 7 }, () => statement()));
    const observability = createInvocationLogger({
      source: "worker",
      trigger: "alarm",
    });

    await runWithInvocationLogger(observability, () =>
      runScheduledTask(env, definition, 1000, async ({ logger }) => {
        await logger.warn("delivery.delayed", "site-123 delayed", {
          siteId: "site-123",
          retryAfterMs: 500,
        });
        return { status: "success" };
      }),
    );

    const record = observability.build();
    expect(record.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "scheduled_task.start" }),
        expect.objectContaining({ message: "scheduled_task.delivery.delayed" }),
        expect.objectContaining({ message: "scheduled_task.finish" }),
      ]),
    );
    expect(
      record.logs.some((entry) => entry.message.includes("site-123")),
    ).toBe(false);
    expect(
      record.logs.find(
        (entry) => entry.message === "scheduled_task.delivery.delayed",
      )?.data,
    ).toBeUndefined();
  });
});
