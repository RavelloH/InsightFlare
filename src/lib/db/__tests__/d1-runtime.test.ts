import { describe, expect, it, vi } from "vitest";

import {
  compileD1Query,
  createD1DatabaseClient,
  createDatabaseRuntime,
  D1_MAX_SQL_UTF8_BYTES,
  type DatabaseObservationSession,
  type DatabasePhysicalPlanShape,
  type DatabaseQueryObservation,
  type DatabaseQueryObserver,
  lowerLogicalPlan,
  param,
  project,
} from "@/lib/db";
import { buildJourneyVisitorDetailPlan } from "@/lib/edge/analytics/engine/journey-entity-detail-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { sha256Hex } from "@/lib/sha256";

function createDatabase() {
  const result = {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 2,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
    results: [{ value: 1 }],
  } satisfies D1Result<{ value: number }>;
  const row = { value: 1 };
  const prepared = {
    bind: vi.fn(() => prepared),
    all: vi.fn(async () => result),
    first: vi.fn(async () => row),
    run: vi.fn(async () => result),
  };
  const database = {
    prepare: vi.fn(() => prepared),
    batch: vi.fn(async () => [result]),
  } as unknown as D1Database;

  return { database, prepared, result, row };
}

const physicalPlanShape: DatabasePhysicalPlanShape = {
  version: 1,
  cteCount: 1,
  directScanProjectionCount: 2,
  nativeMembershipCount: 0,
  jsonMembershipCount: 1,
};

function recordingObserver(
  events: DatabaseQueryObservation[],
): DatabaseQueryObserver {
  return {
    begin({ operation, statementCount }) {
      return {
        statementIndexes:
          operation === "batch"
            ? Array.from(
                { length: Math.min(statementCount, 32) },
                (_unused, index) => index,
              )
            : [0],
        includeBatchSummary: operation === "batch",
        record(event) {
          events.push(event);
        },
        release() {},
      };
    },
  };
}

async function waitForObservations(
  events: DatabaseQueryObservation[],
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count));
}

function compiledJourneyAnchorQuery(
  siteId: string,
  visitorId: string,
  repeatedParameter: string,
) {
  const plan = buildJourneyVisitorDetailPlan({ siteId, visitorId });
  const output = plan.outputs.find(
    (candidate) => candidate.id === "journey-visitor-detail",
  );
  if (!output) throw new Error("journey_detail_output_missing");
  const siteIds = plan.context.subject.siteIds;
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    siteIds.length === 1
      ? { siteId: siteIds[0]!, time: plan.context.time }
      : { siteIds, time: plan.context.time },
  );
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const repeated = project(relation, {
    ...Object.fromEntries(
      Array.from({ length: 100 }, (_unused, index) => [
        `reused_${index}`,
        param(repeatedParameter),
      ]),
    ),
    visitorId: relation.columns.visitorId,
  });
  return compileD1Query(lowerLogicalPlan(repeated));
}

describe("D1 database runtime", () => {
  it("creates a typed database client from a D1 binding", async () => {
    const { database, prepared, row } = createDatabase();
    const client = createD1DatabaseClient(database);
    const query = {
      kind: "query",
      sql: "SELECT value FROM records WHERE id=?",
      bindings: ["record-1"],
    } as const;

    await expect(client.first<{ value: number }>(query)).resolves.toBe(row);

    expect(database.prepare).toHaveBeenCalledExactlyOnceWith(query.sql);
    expect(prepared.bind).toHaveBeenCalledExactlyOnceWith("record-1");
    expect(prepared.first).toHaveBeenCalledExactlyOnceWith();
  });

  it("passes SQL and bindings to D1 without changing them", async () => {
    const { database, prepared, result } = createDatabase();
    const sql = " SELECT value FROM records WHERE id=? AND timestamp>=? ";
    const bindings = ["site-1", 1000, 2000, null];

    await expect(
      createDatabaseRuntime(database).all<{ value: number }>({
        sql,
        bindings,
      }),
    ).resolves.toBe(result);

    expect(database.prepare).toHaveBeenCalledExactlyOnceWith(sql);
    expect(prepared.bind).toHaveBeenCalledExactlyOnceWith(...bindings);
    expect(prepared.all).toHaveBeenCalledExactlyOnceWith();
  });

  it("executes all without bindings when they are omitted or empty", async () => {
    const omitted = createDatabase();
    const empty = createDatabase();
    const runtimeWithoutBindings = createDatabaseRuntime(omitted.database);
    const runtimeWithEmptyBindings = createDatabaseRuntime(empty.database);

    await runtimeWithoutBindings.all({ sql: "SELECT 1" });
    await runtimeWithEmptyBindings.all({ sql: "SELECT 1", bindings: [] });

    expect(omitted.prepared.bind).not.toHaveBeenCalled();
    expect(empty.prepared.bind).toHaveBeenCalledExactlyOnceWith();
  });

  it("uses D1 first directly and preserves its optional column selection", async () => {
    const { database, prepared, row } = createDatabase();
    const runtime = createDatabaseRuntime(database);

    await expect(
      runtime.first<{ value: number }>({
        sql: "SELECT value FROM records WHERE id=?",
        bindings: ["record-1"],
      }),
    ).resolves.toBe(row);
    await runtime.first<number>({ sql: "SELECT value FROM records" }, "value");

    expect(prepared.first).toHaveBeenNthCalledWith(1);
    expect(prepared.first).toHaveBeenNthCalledWith(2, "value");
    expect(prepared.all).not.toHaveBeenCalled();
  });

  it("uses native run with exact SQL and bindings", async () => {
    const { database, prepared, result } = createDatabase();
    const sql = " UPDATE records SET value=? WHERE id=? ";
    const bindings = [false, "record-1", null];

    await expect(
      createDatabaseRuntime(database).run({ sql, bindings }),
    ).resolves.toBe(result);

    expect(database.prepare).toHaveBeenCalledExactlyOnceWith(sql);
    expect(prepared.bind).toHaveBeenCalledExactlyOnceWith(...bindings);
    expect(prepared.run).toHaveBeenCalledExactlyOnceWith();
    expect(prepared.all).not.toHaveBeenCalled();
    expect(prepared.first).not.toHaveBeenCalled();
  });

  it("preserves omitted and empty bindings for run", async () => {
    const omitted = createDatabase();
    const empty = createDatabase();

    await createDatabaseRuntime(omitted.database).run({
      sql: "DELETE FROM records",
    });
    await createDatabaseRuntime(empty.database).run({
      sql: "DELETE FROM records",
      bindings: [],
    });

    expect(omitted.prepared.bind).not.toHaveBeenCalled();
    expect(empty.prepared.bind).toHaveBeenCalledExactlyOnceWith();
  });

  it("prepares batch statements in order and returns native results unchanged", async () => {
    const result = {
      success: true,
      results: [],
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    } satisfies D1Result;
    const results = [result, result, result];
    const preparedStatements = ["A", "B", "C"].map(() => {
      const prepared = {
        bind: vi.fn(() => prepared),
      };
      return prepared;
    });
    const database = {
      prepare: vi
        .fn()
        .mockReturnValueOnce(preparedStatements[0])
        .mockReturnValueOnce(preparedStatements[1])
        .mockReturnValueOnce(preparedStatements[2]),
      batch: vi.fn(async () => results),
    } as unknown as D1Database;
    const statements = [
      { sql: " INSERT A ", bindings: [] },
      { sql: "INSERT B", bindings: [1] },
      { sql: "INSERT C", bindings: ["x", null] },
    ];

    await expect(
      createDatabaseRuntime(database).batch(statements),
    ).resolves.toBe(results);

    expect(database.prepare).toHaveBeenNthCalledWith(1, " INSERT A ");
    expect(database.prepare).toHaveBeenNthCalledWith(2, "INSERT B");
    expect(database.prepare).toHaveBeenNthCalledWith(3, "INSERT C");
    expect(preparedStatements[0].bind).toHaveBeenCalledExactlyOnceWith();
    expect(preparedStatements[1].bind).toHaveBeenCalledExactlyOnceWith(1);
    expect(preparedStatements[2].bind).toHaveBeenCalledExactlyOnceWith(
      "x",
      null,
    );
    expect(database.batch).toHaveBeenCalledExactlyOnceWith(preparedStatements);
  });

  it("rejects over-budget statements before prepare, bind, or batch", () => {
    const { database, prepared } = createDatabase();
    const runtime = createDatabaseRuntime(database);
    const tooManyBindings = {
      sql: "SELECT ?",
      bindings: Array.from({ length: 101 }, () => null),
      tag: "budget.test",
    };

    expect(() => runtime.all(tooManyBindings)).toThrowError(
      expect.objectContaining({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "budget.test",
      }),
    );
    expect(() => runtime.first(tooManyBindings)).toThrowError(
      expect.objectContaining({ code: "d1_statement_budget_exceeded" }),
    );
    expect(() => runtime.run(tooManyBindings)).toThrowError(
      expect.objectContaining({ code: "d1_statement_budget_exceeded" }),
    );
    expect(() =>
      runtime.batch([{ sql: "SELECT 1" }, tooManyBindings]),
    ).toThrowError(
      expect.objectContaining({ code: "d1_statement_budget_exceeded" }),
    );

    expect(database.prepare).not.toHaveBeenCalled();
    expect(prepared.bind).not.toHaveBeenCalled();
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("keeps tags out of SQL and bindings", async () => {
    const { database, prepared } = createDatabase();

    await createDatabaseRuntime(database).all({
      sql: "SELECT value FROM records WHERE id=?",
      bindings: ["record-1"],
      tag: "records.value.find",
    });

    expect(database.prepare).toHaveBeenCalledExactlyOnceWith(
      "SELECT value FROM records WHERE id=?",
    );
    expect(prepared.bind).toHaveBeenCalledExactlyOnceWith("record-1");
  });

  it("observes final parameterized query shape and raw D1 metadata", async () => {
    const { database, prepared, result } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const sql = "SELECT value FROM records WHERE label=?";
    const firstResult = {
      ...result,
      meta: {
        ...result.meta,
        duration: 9.5,
        rows_read: 0,
        rows_written: 0,
        timings: { sql_duration_ms: 0.375 },
      },
    } satisfies D1Result<{ value: number }>;
    prepared.all
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(firstResult);
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const base = {
      sql,
      physicalPlanShape,
      tag: "records.label.find",
    } as const;

    await expect(
      runtime.all({ ...base, bindings: ["private-value-a"] }),
    ).resolves.toBe(firstResult);
    await expect(
      runtime.all({ ...base, bindings: ["private-value-b"] }),
    ).resolves.toBe(firstResult);
    await runtime.all({
      ...base,
      bindings: ["private-value-c"],
      physicalPlanShape: { ...physicalPlanShape, jsonMembershipCount: 0 },
    });
    await waitForObservations(events, 3);

    const expectedHash = `v1:${await sha256Hex(
      JSON.stringify([
        "d1-query-shape-v1",
        sql,
        physicalPlanShape.cteCount,
        physicalPlanShape.directScanProjectionCount,
        physicalPlanShape.nativeMembershipCount,
        physicalPlanShape.jsonMembershipCount,
      ]),
    )}`;
    expect(events).toHaveLength(3);
    const sameShapeEvents = events.filter(
      (event) => event.physicalPlanHash === expectedHash,
    );
    expect(sameShapeEvents).toHaveLength(2);
    expect(sameShapeEvents[0]).toMatchObject({
      version: 1,
      tag: "records.label.find",
      operation: "all",
      status: "success",
      rowsRead: 0,
      rowsWritten: 0,
      dbDurationMs: 0.375,
      sqlBytes: new TextEncoder().encode(sql).byteLength,
      bindings: 1,
      elapsedMs: expect.any(Number),
      physicalPlanHash: expectedHash,
    });
    expect(
      events.some((event) => event.physicalPlanHash !== expectedHash),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-value");
  });

  it("keeps first and exec platform metrics unavailable", async () => {
    const { database, row } = createDatabase();
    const execResult = { count: 1, duration: 2 } satisfies D1ExecResult;
    (database as unknown as { exec: D1Database["exec"] }).exec = vi
      .fn()
      .mockResolvedValue(execResult);
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });

    await expect(
      runtime.first({
        sql: "SELECT value FROM records WHERE id=?",
        bindings: ["record-1"],
        physicalPlanShape,
      }),
    ).resolves.toBe(row);
    await expect(runtime.exec("PRAGMA optimize; VACUUM")).resolves.toBe(
      execResult,
    );
    await waitForObservations(events, 2);

    expect(events.find((event) => event.operation === "first")).toMatchObject({
      operation: "first",
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
      bindings: 1,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(events.find((event) => event.operation === "exec")).toMatchObject({
      operation: "exec",
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
      bindings: 0,
      physicalPlanHash: null,
    });
  });

  it("hashes v2 row-relation emission without including row payload values", async () => {
    const { database } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const sql =
      'SELECT json_extract("_tuple".value, \'$[0]\') AS "_c0" FROM (VALUES (?)) AS "_segments" JOIN json_each("_segments".column1) AS "_tuple"';
    const shape: DatabasePhysicalPlanShape = {
      version: 2,
      cteCount: 0,
      directScanProjectionCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 0,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    };

    await runtime.all({
      sql,
      bindings: ['[["private-row-a"]]'],
      physicalPlanShape: shape,
    });
    await runtime.all({
      sql,
      bindings: ['[["private-row-b"]]'],
      physicalPlanShape: shape,
    });
    await waitForObservations(events, 2);

    const expectedHash = `v2:${await sha256Hex(
      JSON.stringify([
        "d1-query-shape-v2",
        sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
      ]),
    )}`;
    expect(events.map((event) => event.physicalPlanHash)).toEqual([
      expectedHash,
      expectedHash,
    ]);
    expect(JSON.stringify(events)).not.toContain("private-row-");
  });

  it("hashes v3 numbered parameter layouts without including bound values", async () => {
    const { database, result } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const shape: DatabasePhysicalPlanShape = {
      version: 3,
      cteCount: 4,
      directScanProjectionCount: 1,
      nativeMembershipCount: 0,
      jsonMembershipCount: 1,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
      parameterStrategy: "numbered-reuse",
      parameterOccurrenceCount: 101,
      parameterSlotCount: 2,
    };
    const sql = "SELECT ?1 AS first_value, ?2 AS second_value";

    await runtime.all({
      sql,
      bindings: ["private-first-a", "private-second-a"],
      physicalPlanShape: shape,
    });
    await runtime.all({
      sql,
      bindings: ["private-first-b", "private-second-b"],
      physicalPlanShape: shape,
    });
    await waitForObservations(events, 2);

    const expectedHash = `v3:${await sha256Hex(
      JSON.stringify([
        "d1-query-shape-v3",
        sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.parameterStrategy,
        shape.parameterOccurrenceCount,
        shape.parameterSlotCount,
      ]),
    )}`;
    expect(events.map((event) => event.physicalPlanHash)).toEqual([
      expectedHash,
      expectedHash,
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");

    const differentLayout: DatabasePhysicalPlanShape = {
      ...shape,
      parameterSlotCount: 3,
    };
    await runtime.all({
      sql: "SELECT ?1 AS first_value, ?2 AS second_value, ?3 AS third_value",
      bindings: ["a", "b", "c"],
      physicalPlanShape: differentLayout,
    });
    await waitForObservations(events, 3);
    expect(events[2]?.physicalPlanHash).not.toBe(expectedHash);
    expect(result.success).toBe(true);
  });

  it("observes a compiled Journey anchor as value-free v4 including numbered reuse", async () => {
    const events: DatabaseQueryObservation[] = [];
    const { database, prepared } = createDatabase();
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const first = compiledJourneyAnchorQuery(
      "private-site-a",
      "private-visitor-a",
      "private-repeated-a",
    );
    const second = compiledJourneyAnchorQuery(
      "private-site-b",
      "private-visitor-b",
      "private-repeated-b",
    );
    const shape = first.physicalPlanShape;
    expect(shape).toMatchObject({
      version: 4,
      rightAnchorJoinOrderCount: 1,
      uniqueLookupJoinOrderCount: 1,
      parameterStrategy: "numbered-reuse",
    });
    expect(shape?.version).toBe(4);
    if (shape?.version !== 4) throw new Error("journey_v4_shape_missing");
    const occurrenceCount = shape.parameterOccurrenceCount;
    const slotCount = shape.parameterSlotCount;
    if (occurrenceCount === undefined || slotCount === undefined) {
      throw new Error("journey_v4_parameter_counts_missing");
    }
    expect(occurrenceCount).toBeGreaterThan(100);
    expect(slotCount).toBeLessThan(occurrenceCount);
    expect(first.sql).toBe(second.sql);
    expect(first.bindings).not.toEqual(second.bindings);
    expect(first.bindings?.length).toBeLessThan(100);

    await runtime.all(first);
    await runtime.all(second);
    await waitForObservations(events, 2);

    const expectedHash = `v4:${await sha256Hex(
      JSON.stringify([
        "d1-query-shape-v4",
        first.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]),
    )}`;
    expect(events.map((event) => event.physicalPlanHash)).toEqual([
      expectedHash,
      expectedHash,
    ]);
    expect(events[0]).toMatchObject({
      operation: "all",
      status: "success",
      bindings: first.bindings?.length,
      physicalPlanHash: expectedHash,
    });
    expect(prepared.bind).toHaveBeenNthCalledWith(1, ...(first.bindings ?? []));
    expect(prepared.bind).toHaveBeenNthCalledWith(
      2,
      ...(second.bindings ?? []),
    );
    expect(JSON.stringify(events)).not.toContain("private-site-");
    expect(JSON.stringify(events)).not.toContain("private-visitor-");
    expect(JSON.stringify(events)).not.toContain("private-repeated-");
  });

  it("does not hash malformed v4 parameter-slot metadata", async () => {
    const events: DatabaseQueryObservation[] = [];
    const { database } = createDatabase();
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const malformedShape: DatabasePhysicalPlanShape = {
      version: 4,
      cteCount: 0,
      directScanProjectionCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 0,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 0,
      rightAnchorJoinOrderCount: 1,
      uniqueLookupJoinOrderCount: 0,
      parameterStrategy: "numbered-reuse",
      parameterOccurrenceCount: 101,
      parameterSlotCount: 101,
    };

    await runtime.all({ sql: "SELECT 1", physicalPlanShape: malformedShape });
    await waitForObservations(events, 1);
    expect(events[0]).toMatchObject({
      operation: "all",
      status: "success",
      physicalPlanHash: null,
    });
  });

  it("checks actual bindings even when v3 metadata claims fewer slots", async () => {
    const { database, prepared } = createDatabase();
    const runtime = createDatabaseRuntime(database);
    const shape: DatabasePhysicalPlanShape = {
      version: 3,
      cteCount: 1,
      directScanProjectionCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 0,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 0,
      parameterStrategy: "numbered-reuse",
      parameterOccurrenceCount: 101,
      parameterSlotCount: 1,
    };

    expect(() =>
      runtime.all({
        sql: "SELECT ?",
        bindings: Array<string>(101).fill("claimed-as-one-slot"),
        physicalPlanShape: shape,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
      }),
    );
    expect(database.prepare).not.toHaveBeenCalled();
    expect(prepared.all).not.toHaveBeenCalled();
  });

  it("uses valid fallback timing and omits invalid or failed result metrics", async () => {
    const { database, prepared, result: baseResult } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const result = {
      ...baseResult,
      meta: {
        ...baseResult.meta,
        duration: 1.25,
        rows_read: 1.5,
        rows_written: -1,
        timings: { sql_duration_ms: Number.NaN },
      },
    } satisfies D1Result<{ value: number }>;
    prepared.all.mockResolvedValueOnce(result);

    await expect(
      runtime.all({ sql: "SELECT value FROM records" }),
    ).resolves.toBe(result);
    await waitForObservations(events, 1);
    expect(events[0]).toMatchObject({
      status: "success",
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: 1.25,
    });

    const failedResult = {
      ...baseResult,
      success: false,
    } as unknown as typeof baseResult;
    prepared.all.mockResolvedValueOnce(failedResult);
    await expect(
      runtime.all({ sql: "SELECT value FROM records" }),
    ).resolves.toBe(failedResult);
    await waitForObservations(events, 2);
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      status: "failed",
      reason: "result_failure",
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
    });
  });

  it("preserves batch identity and member ordering across concurrent runtimes", async () => {
    const { result: baseResult } = createDatabase();
    const result = {
      ...baseResult,
      meta: {
        ...baseResult.meta,
        rows_read: 0,
        timings: { sql_duration_ms: 0.25 },
      },
    } satisfies D1Result;
    const prepared = {
      bind: vi.fn(() => prepared),
    };
    let calls = 0;
    const database = {
      prepare: vi.fn(() => prepared),
      batch: vi.fn(async () => {
        const call = calls++;
        if (call === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return [result, result];
      }),
    } as unknown as D1Database;
    const events: DatabaseQueryObservation[] = [];
    const observer = recordingObserver(events);
    const firstRuntime = createDatabaseRuntime(database, { observer });
    const secondRuntime = createDatabaseRuntime(database, { observer });

    await Promise.all([
      firstRuntime.batch([{ sql: "INSERT A" }, { sql: "INSERT B" }]),
      secondRuntime.batch([{ sql: "INSERT C" }, { sql: "INSERT D" }]),
    ]);
    await waitForObservations(events, 6);

    const batchIds = new Set(events.map((event) => event.batchId));
    expect(batchIds.size).toBe(2);
    for (const batchId of batchIds) {
      const related = events.filter((event) => event.batchId === batchId);
      expect(related).toHaveLength(3);
      expect(related.find((event) => event.batchIndex === null)).toMatchObject({
        elapsedMs: expect.any(Number),
        statementCount: 2,
      });
      expect(
        related
          .filter((event) => event.batchIndex !== null)
          .map((event) => event.batchIndex)
          .sort(),
      ).toEqual([0, 1]);
    }
    expect(events.filter((event) => event.batchIndex !== null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowsRead: 0, dbDurationMs: 0.25 }),
      ]),
    );
    expect(
      events
        .filter((event) => event.batchIndex !== null)
        .every((event) => event.elapsedMs === null),
    ).toBe(true);
  });

  it("marks missing batch results failed without changing returned results", async () => {
    const { result } = createDatabase();
    const prepared = { bind: vi.fn(() => prepared) };
    const returnedResults = [result];
    const database = {
      prepare: vi.fn(() => prepared),
      batch: vi.fn().mockResolvedValue(returnedResults),
    } as unknown as D1Database;
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });

    await expect(
      runtime.batch([
        { sql: "INSERT INTO records VALUES (1)", tag: "records.first" },
        { sql: "INSERT INTO records VALUES (2)", tag: "records.second" },
      ]),
    ).resolves.toBe(returnedResults);
    await waitForObservations(events, 3);

    expect(events.find((event) => event.batchIndex === null)).toMatchObject({
      status: "failed",
      reason: "missing_batch_result",
      statementCount: 2,
    });
    expect(events.find((event) => event.batchIndex === 0)).toMatchObject({
      status: "success",
      tag: "records.first",
      rowsRead: 2,
    });
    expect(events.find((event) => event.batchIndex === 1)).toMatchObject({
      status: "failed",
      reason: "missing_batch_result",
      tag: "records.second",
      rowsRead: null,
      dbDurationMs: null,
    });
  });

  it("observes a rejected batch before any prepare and isolates observer failures", async () => {
    const { database, prepared, result: baseResult } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const observer = recordingObserver(events);
    const runtime = createDatabaseRuntime(database, { observer });
    const overBudget = {
      sql: "SELECT ?",
      bindings: Array.from({ length: 101 }, () => null),
      tag: "budget.batch",
    };

    expect(() => runtime.batch([{ sql: "SELECT 1" }, overBudget])).toThrowError(
      expect.objectContaining({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
      }),
    );
    expect(database.prepare).not.toHaveBeenCalled();
    expect(database.batch).not.toHaveBeenCalled();
    await waitForObservations(events, 1);
    expect(events[0]).toMatchObject({
      operation: "batch",
      status: "rejected",
      reason: "budget",
      batchIndex: null,
      statementCount: 2,
      budget: { item: "bindings", actual: 101, limit: 100 },
    });

    const result = {
      ...baseResult,
      meta: { ...baseResult.meta, rows_read: 1 },
      results: [],
    };
    prepared.all.mockResolvedValue(result);
    const throwingObserver: DatabaseQueryObserver = {
      begin() {
        return {
          statementIndexes: [0],
          includeBatchSummary: false,
          record: () => Promise.reject(new Error("observer sink failed")),
          release: vi.fn(),
        };
      },
    };
    await expect(
      createDatabaseRuntime(database, { observer: throwingObserver }).all({
        sql: "SELECT 1",
      }),
    ).resolves.toBe(result);
  });

  it("records every selected batch member when D1 rejects the batch", async () => {
    const { database } = createDatabase();
    const error = new Error("original D1 batch rejection");
    vi.mocked(database.batch).mockRejectedValueOnce(error);
    const events: DatabaseQueryObservation[] = [];
    const statements = [
      { sql: "INSERT INTO records VALUES (1)", tag: "records.first" },
      { sql: "INSERT INTO records VALUES (2)", tag: "records.second" },
    ];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });

    await expect(runtime.batch(statements)).rejects.toBe(error);
    await waitForObservations(events, 3);

    const summary = events.find((event) => event.batchIndex === null);
    expect(summary).toMatchObject({
      operation: "batch",
      status: "failed",
      reason: "database_failure",
      batchIndex: null,
      statementCount: 2,
      elapsedMs: expect.any(Number),
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
    });
    const members = events.filter((event) => event.batchIndex !== null);
    expect(members).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "database_failure",
        tag: "records.first",
        batchIndex: 0,
        elapsedMs: null,
        rowsRead: null,
        rowsWritten: null,
        dbDurationMs: null,
      }),
      expect.objectContaining({
        status: "failed",
        reason: "database_failure",
        tag: "records.second",
        batchIndex: 1,
        elapsedMs: null,
        rowsRead: null,
        rowsWritten: null,
        dbDurationMs: null,
      }),
    ]);
    expect(members.map((event) => event.batchId)).toEqual([
      summary?.batchId,
      summary?.batchId,
    ]);
  });

  it("keeps native D1 errors when observer setup or cleanup throws", async () => {
    const { database, prepared } = createDatabase();
    const error = new Error("original D1 query rejection");
    prepared.all.mockRejectedValue(error);
    const beginError = new Error("observer begin failed");
    const beginObserver: DatabaseQueryObserver = {
      begin() {
        throw beginError;
      },
    };
    const throwingRelease = vi.fn(() => {
      throw new Error("observer release failed");
    });
    const unselectedObserver: DatabaseQueryObserver = {
      begin: () => ({
        statementIndexes: [],
        includeBatchSummary: false,
        record: vi.fn(),
        release: throwingRelease,
      }),
    };

    await expect(
      createDatabaseRuntime(database, { observer: beginObserver }).all({
        sql: "SELECT 1",
        physicalPlanShape,
      }),
    ).rejects.toBe(error);
    await expect(
      createDatabaseRuntime(database, { observer: unselectedObserver }).all({
        sql: "SELECT 1",
        physicalPlanShape,
      }),
    ).rejects.toBe(error);

    expect(throwingRelease).toHaveBeenCalledOnce();
    expect(database.prepare).toHaveBeenCalledTimes(2);
  });

  it("returns the D1 result when hashing fails and releases the observer", async () => {
    const { database, prepared, result } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const release = vi.fn();
    const observer: DatabaseQueryObserver = {
      begin: () => ({
        statementIndexes: [0],
        includeBatchSummary: false,
        record: (event) => {
          events.push(event);
        },
        release,
      }),
    };
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("Web Crypto digest failed"));

    try {
      await expect(
        createDatabaseRuntime(database, { observer }).all({
          sql: "SELECT value FROM records",
          physicalPlanShape,
        }),
      ).resolves.toBe(result);
      await waitForObservations(events, 1);
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(events[0]?.physicalPlanHash).toBeNull();
    } finally {
      digest.mockRestore();
    }
    expect(prepared.all).toHaveBeenCalledOnce();
  });

  it("records SQL budget rejections without preparing the statement", async () => {
    const { database } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const statement = {
      sql: "x".repeat(D1_MAX_SQL_UTF8_BYTES + 1),
      physicalPlanShape,
    };

    expect(() => runtime.all(statement)).toThrowError(
      expect.objectContaining({
        code: "d1_statement_budget_exceeded",
        item: "sql_bytes",
        actual: D1_MAX_SQL_UTF8_BYTES + 1,
        limit: D1_MAX_SQL_UTF8_BYTES,
      }),
    );
    expect(database.prepare).not.toHaveBeenCalled();
    await waitForObservations(events, 1);
    expect(events[0]).toMatchObject({
      status: "rejected",
      reason: "budget",
      sqlBytes: D1_MAX_SQL_UTF8_BYTES + 1,
      physicalPlanHash: null,
      budget: {
        item: "sql_bytes",
        actual: D1_MAX_SQL_UTF8_BYTES + 1,
        limit: D1_MAX_SQL_UTF8_BYTES,
      },
    });
  });

  it("uses wall-clock timing when the monotonic clock throws", async () => {
    const { database } = createDatabase();
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });
    const monotonicNow = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => {
        throw new Error("monotonic clock unavailable");
      });

    try {
      await runtime.all({ sql: "SELECT 1" });
      await waitForObservations(events, 1);
      expect(events[0]?.elapsedMs).toEqual(expect.any(Number));
      expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it("omits platform metrics when a result has no metadata", async () => {
    const { database, prepared, result } = createDatabase();
    prepared.all.mockResolvedValueOnce(null as unknown as typeof result);
    const events: DatabaseQueryObservation[] = [];
    const runtime = createDatabaseRuntime(database, {
      observer: recordingObserver(events),
    });

    await expect(runtime.all({ sql: "SELECT 1" })).resolves.toBeNull();
    await waitForObservations(events, 1);
    expect(events[0]).toMatchObject({
      status: "success",
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
    });
  });

  it("preserves the native result when inspecting it throws", async () => {
    const { database, prepared, result: nativeResult } = createDatabase();
    const result = Object.defineProperty({}, "success", {
      get() {
        throw new Error("result inspection failed");
      },
    }) as unknown as typeof nativeResult;
    prepared.all.mockResolvedValueOnce(result);
    const record = vi.fn();
    const release = vi.fn();
    const observer: DatabaseQueryObserver = {
      begin: () => ({
        statementIndexes: [0],
        includeBatchSummary: false,
        record,
        release,
      }),
    };

    await expect(
      createDatabaseRuntime(database, { observer }).all({ sql: "SELECT 1" }),
    ).resolves.toBe(result);
    expect(record).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves the D1 batch error if summary construction fails", async () => {
    const { database } = createDatabase();
    const error = new Error("original D1 batch rejection");
    vi.mocked(database.batch).mockRejectedValueOnce(error);
    const record = vi.fn();
    const release = vi.fn();
    const observer: DatabaseQueryObserver = {
      begin: () => ({
        statementIndexes: [0],
        includeBatchSummary: true,
        record,
        release,
      }),
    };
    let lengthReads = 0;
    const source = [{ sql: "SELECT 1" }];
    const statements = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "length" && ++lengthReads === 4)
          throw new Error("batch length unavailable to observer");
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      createDatabaseRuntime(database, { observer }).batch(statements),
    ).rejects.toBe(error);
    expect(lengthReads).toBe(4);
    expect(record).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores observer session selection failures without changing D1 results", async () => {
    const { database, prepared, result } = createDatabase();
    const selectionGetterRelease = vi.fn();
    const iteratorRelease = vi.fn();
    const summaryGetterRelease = vi.fn();
    const observerFor = (
      session: DatabaseObservationSession,
    ): DatabaseQueryObserver => ({ begin: () => session });
    const selectionGetterObserver = observerFor({
      get statementIndexes(): readonly number[] {
        throw new Error("observer selection getter failed");
      },
      includeBatchSummary: false,
      record: vi.fn(),
      release: selectionGetterRelease,
    });
    const iteratorObserver = observerFor({
      statementIndexes: {
        [Symbol.iterator](): Iterator<number> {
          throw new Error("observer selection iterator failed");
        },
      } as unknown as readonly number[],
      includeBatchSummary: false,
      record: vi.fn(),
      release: iteratorRelease,
    });
    const summaryGetterObserver = observerFor({
      statementIndexes: [0],
      get includeBatchSummary(): boolean {
        throw new Error("observer summary getter failed");
      },
      record: vi.fn(),
      release: summaryGetterRelease,
    });

    await expect(
      createDatabaseRuntime(database, {
        observer: selectionGetterObserver,
      }).all({ sql: "SELECT 1" }),
    ).resolves.toBe(result);
    await expect(
      createDatabaseRuntime(database, { observer: iteratorObserver }).all({
        sql: "SELECT 1",
      }),
    ).resolves.toBe(result);
    expect(prepared.all).toHaveBeenCalledTimes(2);
    expect(selectionGetterRelease).toHaveBeenCalledOnce();
    expect(iteratorRelease).toHaveBeenCalledOnce();

    const queryError = new Error("original D1 query error");
    prepared.all.mockRejectedValueOnce(queryError);
    await expect(
      createDatabaseRuntime(database, { observer: iteratorObserver }).all({
        sql: "SELECT 1",
      }),
    ).rejects.toBe(queryError);

    await expect(
      createDatabaseRuntime(database, {
        observer: summaryGetterObserver,
      }).batch([{ sql: "INSERT INTO records VALUES (1)" }]),
    ).resolves.toEqual([result]);
    const batchError = new Error("original D1 batch error");
    vi.mocked(database.batch).mockRejectedValueOnce(batchError);
    await expect(
      createDatabaseRuntime(database, {
        observer: summaryGetterObserver,
      }).batch([{ sql: "INSERT INTO records VALUES (1)" }]),
    ).rejects.toBe(batchError);
    expect(summaryGetterRelease).toHaveBeenCalledTimes(2);
  });

  it("propagates the original D1 error", async () => {
    const error = new Error("D1 failed");
    const { database, prepared } = createDatabase();
    prepared.all.mockRejectedValue(error);

    await expect(
      createDatabaseRuntime(database).all({ sql: "SELECT 1" }),
    ).rejects.toBe(error);
  });

  it("propagates the original run error", async () => {
    const error = new Error("D1 run failed");
    const { database, prepared } = createDatabase();
    prepared.run.mockRejectedValue(error);

    await expect(
      createDatabaseRuntime(database).run({
        sql: "UPDATE records SET value=1",
      }),
    ).rejects.toBe(error);
  });

  it("propagates the original batch error", async () => {
    const error = new Error("D1 batch failed");
    const { database } = createDatabase();
    vi.mocked(database.batch).mockRejectedValue(error);

    await expect(
      createDatabaseRuntime(database).batch([{ sql: "DELETE FROM records" }]),
    ).rejects.toBe(error);
  });

  it("passes exec SQL through unchanged and returns the native result", async () => {
    const result = { count: 2, duration: 1 } satisfies D1ExecResult;
    const exec = vi.fn(async () => result);
    const database = { exec } as unknown as D1Database;
    const sql = " INSERT INTO records VALUES (1); DELETE FROM records ";

    await expect(createDatabaseRuntime(database).exec(sql)).resolves.toBe(
      result,
    );

    expect(exec).toHaveBeenCalledExactlyOnceWith(sql);
  });

  it("propagates the original exec error", async () => {
    const error = new Error("D1 exec failed");
    const database = {
      exec: vi.fn().mockRejectedValue(error),
    } as unknown as D1Database;

    await expect(createDatabaseRuntime(database).exec("SELECT 1")).rejects.toBe(
      error,
    );
  });
});
