import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  type InvocationLogger,
} from "@/lib/edge/observability/logger";
import {
  isSafeCanonicalPointer,
  MAX_SQL_SEMANTIC_CANDIDATES,
  type SqlSemanticObservationInput,
} from "@/lib/edge/observability/semantic";

const candidate: SqlSemanticObservationInput = {
  sitePk: 11,
  eventNameId: 24,
  jsonPointer: "/checkout/amount",
  valueType: "number",
  indexKind: "range",
  execution: "succeeded",
};

function statementEnv(
  logger: InvocationLogger,
  meta?: Record<string, unknown>,
  fails = false,
) {
  const statement = {
    bind: vi.fn(),
    all: vi.fn(async () => {
      if (fails) throw new Error("D1 failed");
      return { results: [], ...(meta ? { meta } : {}) };
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
    dump: vi.fn(),
    withSession: vi.fn(),
  };
  const env = instrumentEnv(
    {
      DB: db as unknown as D1Database,
      INGEST_DO: {} as DurableObjectNamespace,
    } as Parameters<typeof instrumentEnv>[0],
    logger,
  );
  return { env, db };
}

describe("optional SQL semantic observation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("only accepts trusted semantic hints after settled actual D1 work", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const { env, db } = statementEnv(logger, {
      rows_read: 40,
      timings: { sql_duration_ms: 4 },
    });
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(false);
    await env.DB.prepare("SELECT * FROM events WHERE amount > ?")
      .bind(123)
      .all();
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(true);
    expect(logger.snapshot().sqlObservations).toBeUndefined();
    expect(
      logger.snapshot({ includeSqlSemantics: true }).sqlObservations,
    ).toEqual([
      {
        sitePk: 11,
        eventNameId: 24,
        jsonPointer: "/checkout/amount",
        valueType: "number",
        indexKind: "range",
        requestDemand: 1,
        executions: 1,
        failedExecutions: 0,
      },
    ]);
    expect(logger.snapshot().sql.rowsRead).toEqual({
      coverage: "complete",
      value: 40,
    });
    expect(db.prepare).toHaveBeenCalledTimes(1);
    logger.emit();
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(false);
  });

  it("does not produce index demand from cached responses or non-indexable hints", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const { env } = statementEnv(logger, { rows_read: 4 });
    await env.DB.prepare("SELECT 1").all();
    logger.setPerformance({ cache: "HIT" });
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(false);
    expect(
      logger.snapshot({ includeSqlSemantics: true }).sqlObservations,
    ).toEqual([]);
    expect(isSafeCanonicalPointer("/nested/price~1per_unit")).toBe(true);
    expect(isSafeCanonicalPointer("/checkout/~2bad")).toBe(false);
    for (const pointer of [
      "/user/email@example.com",
      "/payload/{value}",
      "/items/*",
      "/0/amount",
      "/orders/xxxxxxxx-xxxx-4xxx",
      "not/a/pointer",
      "/path/../private",
      "/field?token=secret",
      "/",
    ]) {
      expect(isSafeCanonicalPointer(pointer), pointer).toBe(false);
    }
  });

  it("merges repeated demand per request and caps memory without any SQL I/O", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    logger.setPerformance({ d1FinishedStatements: 1, d1Statements: 1 });
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(true);
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(true);
    const first = logger.snapshot({ includeSqlSemantics: true })
      .sqlObservations?.[0];
    expect(first).toMatchObject({
      requestDemand: 1,
      executions: 2,
      failedExecutions: 0,
    });
    expect(Object.isFrozen(first)).toBe(true);
    for (let index = 1; index < MAX_SQL_SEMANTIC_CANDIDATES; index += 1) {
      expect(
        logger.recordSqlSemanticObservation({
          ...candidate,
          eventNameId: index + 24,
        }),
      ).toBe(true);
    }
    expect(
      logger.recordSqlSemanticObservation({ ...candidate, eventNameId: 99999 }),
    ).toBe(false);
    expect(
      logger.snapshot({ includeSqlSemantics: true }).sqlObservations,
    ).toHaveLength(MAX_SQL_SEMANTIC_CANDIDATES);
  });

  it("keeps semantic metadata away from ordinary consumers", async () => {
    const waiting: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (work) => {
        waiting.push(work);
      },
    });
    logger.setPerformance({ d1FinishedStatements: 1, d1Statements: 1 });
    logger.recordSqlSemanticObservation(candidate);
    const general = vi.fn();
    const index = vi.fn();
    logger.onComplete(general);
    logger.onComplete(index, { includeSqlSemantics: true });
    logger.emit();
    await Promise.all(waiting);
    expect(general).toHaveBeenCalledOnce();
    expect(general.mock.calls[0]?.[0].sqlObservations).toBeUndefined();
    expect(index.mock.calls[0]?.[0].sqlObservations).toHaveLength(1);
    expect(Object.isFrozen(index.mock.calls[0]?.[0].sqlObservations)).toBe(
      true,
    );
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("tracks failed SQL separately without inventing meta, and excludes invalid values", async () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const { env } = statementEnv(logger, undefined, true);
    await expect(env.DB.prepare("SELECT 1").all()).rejects.toThrow();
    expect(
      logger.recordSqlSemanticObservation({
        ...candidate,
        execution: "failed",
      }),
    ).toBe(true);
    expect(logger.recordSqlSemanticObservation(candidate)).toBe(false);
    expect(
      logger.recordSqlSemanticObservation({ ...candidate, sitePk: -1 }),
    ).toBe(false);
    expect(
      logger.recordSqlSemanticObservation({
        ...candidate,
        sitePk: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(false);
    expect(
      logger.recordSqlSemanticObservation({
        ...candidate,
        jsonPointer: "/users/email@example.com",
      }),
    ).toBe(false);
    expect(
      logger.snapshot({ includeSqlSemantics: true }).sqlObservations,
    ).toMatchObject([{ executions: 1, failedExecutions: 1 }]);
    expect(logger.snapshot().sql.rowsRead).toEqual({ coverage: "unavailable" });
  });
});
