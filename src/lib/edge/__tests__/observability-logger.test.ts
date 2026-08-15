import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentEnv } from "@/lib/edge/observability-bindings";
import { measureExternalFetch } from "@/lib/edge/observability-bindings";
import {
  createInvocationLogger,
  currentInvocationLogger,
  MAX_INVOCATION_LOG_EVENTS,
  measureCurrentExternalFetch,
  runWithInvocationLogger,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

describe("edge observability logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a request record with relative events and aggregate counters", () => {
    let now = 100;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      traceId: "trace-1",
      startedAt: "2026-08-15T12:00:00.000Z",
      now: () => now,
    });

    logger.info("request.started");
    now = 112.4;
    logger.setPerformance({
      cache: "MISS",
      dataSource: "raw",
      d1RowsReadAvailable: true,
    });
    logger.increment("d1Statements");
    logger.increment("d1RowsRead", 12.9);
    logger.warn("query.completed");
    logger.setRequest({
      route: "private.visitors.list",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    now = 125.6;

    expect(logger.build()).toEqual({
      v: 1,
      source: "worker",
      trigger: "request",
      traceId: "trace-1",
      startedAt: "2026-08-15T12:00:00.000Z",
      request: {
        route: "private.visitors.list",
        method: "GET",
        status: 200,
        outcome: "ok",
      },
      performance: {
        durationMs: 26,
        cache: "MISS",
        dataSource: "raw",
        d1RowsReadAvailable: true,
        d1Statements: 1,
        d1RowsRead: 12,
      },
      logs: [
        { timeMs: 0, level: "info", message: "request.started" },
        { timeMs: 12, level: "warn", message: "query.completed" },
      ],
    });
  });

  it("emits a structured record once at the most severe invocation level", () => {
    let now = 0;
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      now: () => now,
    });
    logger.error("flush.failed");
    logger.setPerformance({ failedStatements: 1 });
    now = 42;

    const first = logger.emit();
    now = 84;
    const second = logger.emit();

    expect(second).toBe(first);
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith({
      v: 1,
      source: "do",
      trigger: "alarm",
      startedAt: expect.any(String),
      performance: { durationMs: 42, failedStatements: 1 },
      logs: [{ timeMs: 0, level: "error", message: "flush.failed" }],
    });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("uses warning output for client failures and normal output otherwise", () => {
    const clientFailure = createInvocationLogger({
      source: "worker",
      trigger: "request",
      now: () => 0,
    });
    clientFailure.setRequest({
      route: "api.public.share",
      method: "GET",
      status: 404,
      outcome: "error",
    });
    clientFailure.emit();

    const success = createInvocationLogger({
      source: "worker",
      trigger: "request",
      now: () => 0,
    });
    success.setRequest({
      route: "healthz",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    success.emit();

    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("bounds events and ignores invalid counter increments", () => {
    let now = 10;
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      maxEvents: 1,
      now: () => now,
    });
    logger.info("flush.started");
    now = 20;
    logger.info("flush.completed");
    logger.increment("d1RowsWritten", -1);
    logger.increment("d1RowsWritten", Number.NaN);
    logger.increment("d1RowsWritten", 3.9);

    expect(logger.build()).toMatchObject({
      performance: { durationMs: 10, d1RowsWritten: 3 },
      logs: [{ timeMs: 0, level: "info", message: "flush.started" }],
      logsTruncated: true,
    });
  });

  it("records detailed spans and waits for tracked background work before emission", async () => {
    let now = 0;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      now: () => now,
    });
    const span = logger.startSpan("d1.all", { statementKind: "select" });
    now = 7;
    span.end({ rows: 3 });

    let resolveBackground: (() => void) | undefined;
    const background = new Promise<void>((resolve) => {
      resolveBackground = resolve;
    });
    logger.track(background);
    const emitted = logger.emitWhenComplete();
    expect(console.log).not.toHaveBeenCalled();
    now = 12;
    resolveBackground?.();

    await expect(emitted).resolves.toMatchObject({
      performance: {
        durationMs: 12,
        operations: {
          "d1.all": { count: 1, durationMs: 7, failed: 0 },
        },
      },
      logs: [
        {
          timeMs: 0,
          level: "info",
          message: "d1.all.started",
          data: { statementKind: "select" },
        },
        {
          timeMs: 7,
          level: "info",
          message: "d1.all.completed",
          data: { rows: 3, durationMs: 7 },
        },
      ],
    });
  });

  it("keeps the invocation logger scoped to async work and measures direct fetches", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });

    await runWithInvocationLogger(logger, async () => {
      expect(currentInvocationLogger()).toBe(logger);
      const response = await measureCurrentExternalFetch(
        "external_fetch.github_releases",
        () => Promise.resolve(new Response(null, { status: 204 })),
      );
      expect(response.status).toBe(204);
    });

    expect(currentInvocationLogger()).toBeUndefined();
    expect(logger.build()).toMatchObject({
      performance: {
        externalFetches: 1,
        operations: {
          "external_fetch.github_releases": {
            count: 1,
            failed: 0,
          },
        },
      },
      logs: expect.arrayContaining([
        expect.objectContaining({
          message: "external_fetch.github_releases.started",
        }),
        expect.objectContaining({
          message: "external_fetch.github_releases.completed",
          data: expect.objectContaining({ status: 204 }),
        }),
      ]),
    });
  });

  it("records failures from direct fetches in the current invocation", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });

    await expect(
      runWithInvocationLogger(logger, () =>
        measureCurrentExternalFetch("external_fetch.failing", () =>
          Promise.reject(new TypeError("network unavailable")),
        ),
      ),
    ).rejects.toThrow("network unavailable");

    expect(logger.build()).toMatchObject({
      performance: {
        externalFetches: 1,
        failedExternalFetches: 1,
        operations: {
          "external_fetch.failing": { count: 1, failed: 1 },
        },
      },
      logs: expect.arrayContaining([
        expect.objectContaining({
          message: "external_fetch.failing.failed",
          data: expect.objectContaining({ errorName: "TypeError" }),
        }),
      ]),
    });
  });

  it("instruments D1 statements from the request environment", async () => {
    const statement = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({
        results: [{ value: 1 }],
        meta: {
          rows_read: 9,
          changes: 0,
          timings: { sql_duration_ms: 4 },
          total_attempts: 2,
        },
      }),
      first: vi.fn(),
      run: vi.fn(),
      raw: vi.fn(),
    };
    statement.bind.mockImplementation(() => statement);
    const database: D1Database = {
      prepare: () => statement as D1PreparedStatement,
      batch: vi.fn(),
      exec: vi.fn(),
      withSession: vi.fn(),
      dump: vi.fn(),
    };
    const env = {
      DB: database,
      INGEST_DO: {} as DurableObjectNamespace,
    };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const instrumented = instrumentEnv(env, logger);

    await instrumented.DB.prepare("SELECT value FROM metrics")
      .bind("ignored")
      .all();

    expect(logger.build()).toMatchObject({
      performance: {
        d1Statements: 1,
        d1RowsRead: 9,
        d1SqlDurationMs: 4,
        d1TotalAttempts: 2,
        d1Retries: 1,
        operations: {
          "d1.all": { count: 1, failed: 0 },
        },
      },
      logs: expect.arrayContaining([
        expect.objectContaining({
          message: "d1.all.started",
          data: { statementKind: "select", bindingCount: 1 },
        }),
        expect.objectContaining({ message: "d1.all.completed" }),
      ]),
    });
  });

  it("instruments D1 batches, storage bindings, DO RPC, and external fetches", async () => {
    const statement = {
      bind: vi.fn(),
      all: vi.fn(),
      first: vi.fn(),
      run: vi.fn(),
      raw: vi.fn(),
    };
    statement.bind.mockImplementation(() => statement);
    const result = {
      results: [],
      meta: { rows_read: 1, changes: 2, total_attempts: 1 },
    };
    const database: D1Database = {
      prepare: () => statement as D1PreparedStatement,
      batch: vi.fn().mockResolvedValue([result]),
      exec: vi.fn().mockResolvedValue({ count: 1, duration: 2 }),
      withSession: vi.fn(),
      dump: vi.fn(),
    };
    const kv: KVNamespace = {
      get: vi.fn().mockResolvedValue("value"),
      getWithMetadata: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };
    const bucket: R2Bucket = {
      get: vi.fn().mockResolvedValue(null),
      head: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    };
    const stub = {
      id: {} as DurableObjectId,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      connect: vi.fn(),
    } satisfies DurableObjectStub;
    const namespace: DurableObjectNamespace = {
      get: vi.fn(() => stub),
      newUniqueId: vi.fn(),
      idFromName: vi.fn(),
      idFromString: vi.fn(),
      getByName: vi.fn(),
      jurisdiction: vi.fn(),
    };
    const env = {
      DB: database,
      INGEST_DO: namespace,
      SITE_SETTINGS_KV: kv,
      ARCHIVE_BUCKET: bucket,
    };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const instrumented = instrumentEnv(env, logger);

    await instrumented.DB.batch([instrumented.DB.prepare("UPDATE visits")]);
    await instrumented.DB.exec("DELETE FROM visits WHERE expired = 1");
    await instrumented.SITE_SETTINGS_KV?.get("settings");
    await instrumented.ARCHIVE_BUCKET?.get("archive");
    await instrumented.INGEST_DO.get({} as DurableObjectId).fetch(
      "https://ingest.internal/active",
    );
    await measureExternalFetch(logger, "external_fetch.test", () =>
      Promise.resolve(new Response(null, { status: 503 })),
    );

    expect(logger.build()).toMatchObject({
      performance: {
        d1Statements: 2,
        d1RowsWritten: 2,
        kvOperations: 1,
        r2Operations: 1,
        doCalls: 1,
        externalFetches: 1,
        failedExternalFetches: 1,
        operations: expect.objectContaining({
          "d1.batch": expect.objectContaining({ count: 1 }),
          "d1.exec": expect.objectContaining({ count: 1 }),
          "kv.get": expect.objectContaining({ count: 1 }),
          "r2.get": expect.objectContaining({ count: 1 }),
          "do.fetch": expect.objectContaining({ count: 1 }),
          "external_fetch.test": expect.objectContaining({ count: 1 }),
        }),
      },
    });
  });

  it("normalizes invalid limits and non-finite elapsed time", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      maxEvents: 0,
      now: () => Number.NaN,
    });
    for (let index = 0; index < MAX_INVOCATION_LOG_EVENTS + 1; index += 1) {
      logger.info(`event.${index}`);
    }

    expect(logger.build()).toMatchObject({
      performance: { durationMs: 0 },
      logs: expect.arrayContaining([
        { timeMs: 0, level: "info", message: "event.0" },
      ]),
      logsTruncated: true,
    });
  });
});
