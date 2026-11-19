import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  type InvocationLogger,
} from "@/lib/edge/observability/logger";
import type { InvocationSnapshot } from "@/lib/edge/observability/snapshot";

function fakeD1() {
  const statement = {
    bind: vi.fn(),
    all: vi.fn(async () => ({
      results: [{ count: 1 }],
      meta: {
        rows_read: 27,
        rows_written: 0,
        total_attempts: 2,
        timings: { sql_duration_ms: 6 },
      },
    })),
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
  return { db, statement };
}

function bindingFor(
  logger: InvocationLogger,
  database: ReturnType<typeof fakeD1>["db"],
) {
  return instrumentEnv(
    {
      DB: database as unknown as D1Database,
      INGEST_DO: {} as DurableObjectNamespace,
    } as Parameters<typeof instrumentEnv>[0],
    logger,
  );
}

describe("Filter-SQL and smart-index consumer contract", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows independent fake consumers after an actual SQL without extra D1 operations", async () => {
    const waitUntil: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (work) => {
        waitUntil.push(work);
      },
    });
    const { db } = fakeD1();
    const env = bindingFor(logger, db);
    const filterCalls: InvocationSnapshot[] = [];
    const indexCalls: InvocationSnapshot[] = [];
    const diagnosticsCalls: InvocationSnapshot[] = [];

    logger.onComplete((s) => {
      filterCalls.push(s);
    });
    logger.onComplete(() => {
      throw new Error("fake diagnostics failed");
    });
    logger.onComplete(
      (s) => {
        indexCalls.push(s);
      },
      { includeSqlSemantics: true },
    );
    logger.onComplete((s) => {
      diagnosticsCalls.push(s);
    });
    const result = await env.DB.prepare(
      "SELECT count(*) FROM events WHERE json_extract(properties, ?) > ?",
    )
      .bind("$.checkout.amount", 50)
      .all();
    expect(result.results).toEqual([{ count: 1 }]);

    // Only the trusted query caller knows this was an executed scalar range predicate.
    expect(
      logger.recordSqlSemanticObservation({
        sitePk: 1,
        eventNameId: 2,
        jsonPointer: "/checkout/amount",
        valueType: "number",
        indexKind: "range",
        execution: "succeeded",
      }),
    ).toBe(true);

    logger.setRequest({
      route: "/api/v1/report/visitor-secret",
      method: "POST",
      status: 200,
      outcome: "ok",
    });
    const original = logger.emit();
    await Promise.all(waitUntil);

    expect(original.request?.status).toBe(200);
    expect(filterCalls).toHaveLength(1);
    expect(indexCalls).toHaveLength(1);
    expect(diagnosticsCalls).toHaveLength(1);
    expect(filterCalls[0].sqlObservations).toBeUndefined();
    expect(diagnosticsCalls[0].sqlObservations).toBeUndefined();
    expect(indexCalls[0].sqlObservations).toEqual([
      {
        sitePk: 1,
        eventNameId: 2,
        jsonPointer: "/checkout/amount",
        valueType: "number",
        indexKind: "range",
        requestDemand: 1,
        executions: 1,
        failedExecutions: 0,
      },
    ]);
    expect(filterCalls[0].sql).toMatchObject({
      statements: 1,
      rowsRead: { coverage: "complete", value: 27 },
      rowsWritten: { coverage: "complete", value: 0 },
      totalAttempts: { coverage: "complete", value: 2 },
      retries: { coverage: "complete", value: 1 },
    });
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("never incurs diagnostic D1 reads for a normal cache HIT", async () => {
    const waitUntil: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: (work) => {
        waitUntil.push(work);
      },
    });
    const { db } = fakeD1();
    bindingFor(logger, db);
    logger.setPerformance({ cache: "HIT" });
    const filter = vi.fn();
    const index = vi.fn();
    logger.onComplete(filter);
    logger.onComplete(index, { includeSqlSemantics: true });
    logger.emit();
    await Promise.all(waitUntil);
    expect(filter).toHaveBeenCalledOnce();
    expect(index).toHaveBeenCalledOnce();
    expect(filter.mock.calls[0][0].sql.rowsRead).toEqual({
      coverage: "unavailable",
    });
    expect(index.mock.calls[0][0].sqlObservations).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("does not require subscriptions for original Worker structured logs", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    logger.setRequest({
      route: "healthz",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    logger.info("request.completed");
    const record = logger.emit();
    expect(console.log).toHaveBeenCalledOnce();
    expect(record.logs[0]?.message).toBe("request.completed");
  });
});
