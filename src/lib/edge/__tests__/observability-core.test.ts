import { describe, expect, it, vi } from "vitest";

import { instrumentEnv } from "@/lib/edge/observability/bindings";
import { createInvocationLogger } from "@/lib/edge/observability/logger";

function mockDatabase(responses: unknown[]) {
  const values = [...responses];
  const statement = {
    bind: vi.fn(),
    all: vi.fn(async () => {
      const result = values.shift();
      if (result instanceof Error) throw result;
      return result;
    }),
    first: vi.fn(),
    run: vi.fn(),
    raw: vi.fn(),
  };
  statement.bind.mockImplementation(() => statement);
  const db = {
    prepare: vi.fn(() => statement as unknown as D1PreparedStatement),
    batch: vi.fn(),
    exec: vi.fn(),
    withSession: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
  return db;
}

function wrap(
  db: D1Database,
  logger: ReturnType<typeof createInvocationLogger>,
) {
  return instrumentEnv(
    { DB: db, INGEST_DO: {} as DurableObjectNamespace } as Parameters<
      typeof instrumentEnv
    >[0],
    logger,
  );
}

describe("request-local D1 binding identity", () => {
  it("reuses the proxy within an invocation but not across invocations or changed bindings", () => {
    const db = mockDatabase([]);
    const raw = { DB: db } as Parameters<typeof instrumentEnv>[0];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const observed = instrumentEnv(raw, logger);
    const first = observed.DB;
    expect(first).not.toBe(db);
    expect(observed.DB).toBe(first);
    expect(instrumentEnv(observed, logger).DB).toBe(first);
    const other = instrumentEnv(
      raw,
      createInvocationLogger({ source: "worker", trigger: "request" }),
    );
    expect(other.DB).not.toBe(first);
    raw.DB = mockDatabase([]);
    expect(observed.DB).not.toBe(first);
    expect(observed.DB).toBe(observed.DB);
  });
});
describe("minimal invocation SQL cost snapshot", () => {
  it("is an allowlisted, deeply frozen projection and never exposes identity or raw values", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      traceId: "trace-token-secret",
      startedAt: "2026-11-19T01:00:00Z",
      now: () => 42,
    });
    logger.info("user.metadata", {
      token: "user-secret",
      email: "private@example.com",
      sql: "SELECT * FROM users WHERE id='secret'",
    });
    logger.setRequest({
      route: "/api/private@example.com/session/user-secret",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    logger.setPerformance({
      operations: {
        "query.private@example.com": { count: 1, durationMs: 7, failed: 0 },
        "route.handler": { count: 1, durationMs: 18, failed: 0 },
      },
    });
    const snapshot = logger.snapshot();
    expect(snapshot).toMatchObject({
      routeGroup: "api",
      method: "GET",
      status: 200,
      handlerDurationMs: 18,
      sql: {
        statements: 0,
        rowsRead: { coverage: "unavailable" },
      },
      operations: [{ name: "route.handler", count: 1, failed: 0 }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sql)).toBe(true);
    expect(Object.isFrozen(snapshot.operations)).toBe(true);
    expect(Object.isFrozen(snapshot.operations[0])).toBe(true);
    const output = JSON.stringify(snapshot);
    for (const secret of [
      "trace-token-secret",
      "user-secret",
      "private@example.com",
      "SELECT *",
      "2026-11-19",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(logger.build().traceId).toBe("trace-token-secret");
  });

  it("distinguishes all-known zero from entirely missing D1 meta", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const db = mockDatabase([
      {
        results: [],
        meta: {
          rows_read: 0,
          rows_written: 0,
          timings: { sql_duration_ms: 0 },
          total_attempts: 1,
        },
      },
      { results: [] },
    ]);
    const env = wrap(db, logger);
    await env.DB.prepare("SELECT * FROM events WHERE id = ?")
      .bind("secret")
      .all();
    expect(logger.snapshot().sql).toMatchObject({
      statements: 1,
      finishedStatements: 1,
      rowsRead: { coverage: "complete", value: 0 },
      rowsWritten: { coverage: "complete", value: 0 },
      cumulativeSqlDurationMs: { coverage: "complete", value: 0 },
      totalAttempts: { coverage: "complete", value: 1 },
      retries: { coverage: "complete", value: 0 },
    });
    await env.DB.prepare("SELECT * FROM events").all();
    expect(logger.snapshot().sql).toMatchObject({
      statements: 2,
      finishedStatements: 2,
      rowsRead: { coverage: "partial", value: 0 },
      rowsWritten: { coverage: "partial", value: 0 },
      cumulativeSqlDurationMs: { coverage: "partial", value: 0 },
      totalAttempts: { coverage: "partial", value: 1 },
    });
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("marks missing and failed statement metadata unavailable instead of reporting zero", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(
      mockDatabase([{ results: [] }, new Error("D1 failed")]),
      logger,
    );
    await env.DB.prepare("SELECT 1").all();
    expect(logger.snapshot().sql.rowsRead).toEqual({ coverage: "unavailable" });
    await expect(env.DB.prepare("SELECT 2").all()).rejects.toThrow("D1 failed");
    expect(logger.snapshot().sql).toMatchObject({
      statements: 2,
      finishedStatements: 1,
      unobservedStatements: 1,
      settledOperations: 2,
      failedStatements: 1,
      rowsRead: { coverage: "unavailable" },
      rowsWritten: { coverage: "unavailable" },
      cumulativeSqlDurationMs: { coverage: "unavailable" },
      totalAttempts: { coverage: "unavailable" },
    });
    expect("value" in logger.snapshot().sql.rowsRead).toBe(false);
  });

  it("does not equate concurrent cumulative SQL engine time to waited handler duration", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(
      mockDatabase([
        {
          results: [],
          meta: {
            rows_read: 10,
            rows_written: 0,
            timings: { sql_duration_ms: 19 },
            total_attempts: 2,
          },
        },
        {
          results: [],
          meta: {
            rows_read: 20,
            rows_written: 0,
            timings: { sql_duration_ms: 17 },
            total_attempts: 1,
          },
        },
      ]),
      logger,
    );
    await Promise.all([
      env.DB.prepare("SELECT 1").all(),
      env.DB.prepare("SELECT 2").all(),
    ]);
    logger.setPerformance({
      operations: { "route.handler": { count: 1, durationMs: 21, failed: 0 } },
    });
    const snapshot = logger.snapshot();
    expect(snapshot.handlerDurationMs).toBe(21);
    expect(snapshot.sql.cumulativeSqlDurationMs).toEqual({
      coverage: "complete",
      value: 36,
    });
    expect(snapshot.sql.rowsRead).toEqual({ coverage: "complete", value: 30 });
    expect(snapshot.sql.retries).toEqual({ coverage: "complete", value: 1 });
  });

  it("retains fractional D1 SQL engine time without changing integer counters", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(
      mockDatabase([
        {
          results: [],
          meta: {
            rows_read: 2,
            rows_written: 0,
            timings: { sql_duration_ms: 0.75 },
            total_attempts: 1,
          },
        },
        {
          results: [],
          meta: {
            rows_read: 3,
            rows_written: 1,
            timings: { sql_duration_ms: 1.375 },
            total_attempts: 2,
          },
        },
        {
          results: [],
          meta: {
            rows_read: 0,
            rows_written: 0,
            timings: { sql_duration_ms: 0 },
            total_attempts: 1,
          },
        },
      ]),
      logger,
    );
    await env.DB.prepare("SELECT 1").all();
    expect(logger.snapshot().sql.cumulativeSqlDurationMs).toEqual({
      coverage: "complete",
      value: 0.75,
    });
    await env.DB.prepare("SELECT 2").all();
    await env.DB.prepare("SELECT 3").all();
    expect(logger.snapshot().sql).toMatchObject({
      statements: 3,
      finishedStatements: 3,
      unobservedStatements: 0,
      settledOperations: 3,
      rowsRead: { coverage: "complete", value: 5 },
      rowsWritten: { coverage: "complete", value: 1 },
      cumulativeSqlDurationMs: { coverage: "complete", value: 2.125 },
      totalAttempts: { coverage: "complete", value: 4 },
      retries: { coverage: "complete", value: 1 },
    });
    expect(logger.build().performance.d1SqlDurationMs).toBe(2.125);
  });

  it("does not pass invalid duration or fractional row counts off as valid metadata", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(
      mockDatabase([
        {
          results: [],
          meta: {
            rows_read: 2.3,
            rows_written: 0,
            timings: { sql_duration_ms: -0.25 },
            total_attempts: 1.5,
          },
        },
        {
          results: [],
          meta: {
            rows_read: 4,
            rows_written: 0,
            timings: { sql_duration_ms: 0.125 },
            total_attempts: 1,
          },
        },
      ]),
      logger,
    );
    await env.DB.prepare("SELECT 1").all();
    expect(logger.snapshot().sql).toMatchObject({
      rowsRead: { coverage: "unavailable" },
      rowsWritten: { coverage: "complete", value: 0 },
      cumulativeSqlDurationMs: { coverage: "unavailable" },
      totalAttempts: { coverage: "unavailable" },
    });
    await env.DB.prepare("SELECT 2").all();
    expect(logger.snapshot().sql).toMatchObject({
      rowsRead: { coverage: "partial", value: 4 },
      cumulativeSqlDurationMs: { coverage: "partial", value: 0.125 },
      totalAttempts: { coverage: "partial", value: 1 },
    });
  });

  it("does not invent completed SQL from a short, malformed or sparse batch", async () => {
    const statement = {
      bind: vi.fn(),
      all: vi.fn(),
      first: vi.fn(),
      run: vi.fn(),
      raw: vi.fn(),
    };
    statement.bind.mockImplementation(() => statement);
    const batch = vi
      .fn()
      .mockResolvedValueOnce([
        {
          results: [],
          meta: {
            rows_read: 7,
            rows_written: 0,
            timings: { sql_duration_ms: 0.75 },
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        undefined,
        { results: [], meta: { rows_read: 1 } },
      ])
      .mockResolvedValueOnce({ malformed: true });
    const db = {
      prepare: vi.fn(() => statement as unknown as D1PreparedStatement),
      batch,
      exec: vi.fn(),
      withSession: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(db, logger);
    const makeBatch = () => [
      env.DB.prepare("SELECT 1"),
      env.DB.prepare("SELECT 2"),
    ];

    await env.DB.batch(makeBatch());
    expect(logger.snapshot().sql).toMatchObject({
      statements: 2,
      finishedStatements: 1,
      unobservedStatements: 1,
      settledOperations: 1,
      rowsRead: { coverage: "partial", value: 7 },
      cumulativeSqlDurationMs: { coverage: "partial", value: 0.75 },
    });
    await env.DB.batch(makeBatch());
    expect(logger.snapshot().sql).toMatchObject({
      statements: 4,
      finishedStatements: 1,
      unobservedStatements: 3,
      settledOperations: 2,
    });
    await env.DB.batch(makeBatch());
    expect(logger.snapshot().sql).toMatchObject({
      statements: 6,
      finishedStatements: 2,
      unobservedStatements: 4,
      settledOperations: 3,
      rowsRead: { coverage: "partial", value: 8 },
    });
    await env.DB.batch(makeBatch());
    expect(logger.snapshot().sql).toMatchObject({
      statements: 8,
      finishedStatements: 2,
      unobservedStatements: 6,
      settledOperations: 4,
    });
    expect(batch).toHaveBeenCalledTimes(4);
  });

  it("does not treat rejected batch statements as individually completed", async () => {
    const statement = {
      bind: vi.fn(),
      all: vi.fn(),
      first: vi.fn(),
      run: vi.fn(),
      raw: vi.fn(),
    };
    const db = {
      prepare: vi.fn(() => statement as unknown as D1PreparedStatement),
      batch: vi.fn().mockRejectedValue(new Error("batch rejected")),
      exec: vi.fn(),
      dump: vi.fn(),
      withSession: vi.fn(),
    } as unknown as D1Database;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = wrap(db, logger);
    await expect(
      env.DB.batch([env.DB.prepare("SELECT 1"), env.DB.prepare("SELECT 2")]),
    ).rejects.toThrow("batch rejected");
    expect(logger.snapshot().sql).toMatchObject({
      statements: 2,
      finishedStatements: 0,
      unobservedStatements: 2,
      settledOperations: 1,
      failedStatements: 2,
      rowsRead: { coverage: "unavailable" },
    });
  });

  it("keeps HIT separate from unknown SQL cost and requires no D1 read/write", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const db = mockDatabase([]);
    wrap(db, logger);
    logger.setPerformance({ cache: "HIT" });
    const snapshot = logger.snapshot();
    expect(snapshot.cache).toBe("HIT");
    expect(snapshot.sql.statements).toBe(0);
    expect(snapshot.sql.rowsRead).toEqual({ coverage: "unavailable" });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("does not confuse WebSocket lifetime with a handler span", () => {
    const logger = createInvocationLogger({
      source: "do",
      trigger: "websocket",
    });
    logger.setRequest({
      route: "/ws/token-secret",
      method: "WEBSOCKET",
      status: 101,
      outcome: "ok",
    });
    logger.setPerformance({ webSocketDurationMs: 600_000 });
    expect(logger.snapshot()).toMatchObject({
      trigger: "websocket",
      routeGroup: "websocket",
      webSocketConnectionDurationMs: 600_000,
    });
    expect(logger.snapshot().handlerDurationMs).toBeUndefined();
  });
});
