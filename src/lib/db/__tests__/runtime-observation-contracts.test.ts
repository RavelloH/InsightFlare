import { describe, expect, it, vi } from "vitest";

import {
  compileD1Query,
  constant,
  createDatabaseRuntime,
  type DatabaseObservationSession,
  type DatabasePhysicalPlanShape,
  type DatabaseQueryObservation,
  type DatabaseQueryObserver,
  eq,
  filter,
  param,
  project,
  rowNumber,
  scan,
  schema,
  sort,
  window,
} from "@/lib/db";
import type { Relation } from "@/lib/db/query/plan";

function compileOrderStatement() {
  const identities = scan(schema.site_identities);
  const source = project(identities, { key: identities.columns.site_pk! });
  const filtered = filter(source, eq(source.columns.key!, param(1)));
  let current: Relation = filtered;
  for (let index = 0; index < 5; index += 1) {
    const key = current.columns.key!;
    const ranked = window(current, {
      rank: rowNumber({
        partitionBy: [key],
        orderBy: [{ expression: key, direction: "ASC" }],
      }),
    });
    const selected = filter(ranked, eq(ranked.columns.rank!, constant(1)));
    current = project(selected, { key: selected.columns.key! });
  }
  const statement = compileD1Query(
    sort(current, [{ expression: current.columns.key!, direction: "ASC" }]),
  );
  const shape = statement.physicalPlanShape;
  if (!shape || !("compileOrder" in shape))
    throw new Error("compiled_physical_shape_missing_order_metadata");
  return statement;
}

function observationObserver(
  events: DatabaseQueryObservation[],
  release = vi.fn(),
): {
  readonly observer: DatabaseQueryObserver;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const observer: DatabaseQueryObserver = {
    begin: () =>
      ({
        statementIndexes: [0],
        includeBatchSummary: false,
        record(event) {
          events.push(event);
        },
        release,
      }) satisfies DatabaseObservationSession,
  };
  return { observer, release };
}

describe("D1 runtime observation contracts", () => {
  it("observes a versioned compiler shape when synchronous D1 preparation fails", async () => {
    const statement = {
      ...compileOrderStatement(),
      tag: "compile-order.read",
    };
    const failure = new Error("native prepare failure");
    const prepare = vi.fn(() => {
      throw failure;
    });
    const database = { prepare } as unknown as D1Database;
    const events: DatabaseQueryObservation[] = [];
    const { observer, release } = observationObserver(events);
    const runtime = createDatabaseRuntime(database, { observer });

    let thrown: unknown;
    try {
      void runtime.all(statement);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(prepare).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({
      operation: "all",
      tag: "compile-order.read",
      status: "failed",
      reason: "database_failure",
      elapsedMs: expect.any(Number),
      rowsRead: null,
      rowsWritten: null,
      dbDurationMs: null,
      physicalPlanHash: expect.any(String),
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns the native result and omits a hash for malformed compiled shape metadata", async () => {
    const compiled = compileOrderStatement();
    const shape = compiled.physicalPlanShape;
    if (!shape || !("compileOrder" in shape))
      throw new Error("compiled_physical_shape_missing_order_metadata");
    const malformedShape = {
      ...shape,
      compileOrder: {
        ...shape.compileOrder,
        leafCount: shape.compileOrder.leafCount + 1,
      },
    } as unknown as DatabasePhysicalPlanShape;
    const statement = { ...compiled, physicalPlanShape: malformedShape };
    const result = {
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 1,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
      results: [{ key: 1 }],
    } satisfies D1Result<{ key: number }>;
    const prepared = {
      bind: vi.fn(() => prepared),
      all: vi.fn(async () => result),
    };
    const prepare = vi.fn(() => prepared);
    const database = { prepare } as unknown as D1Database;
    const events: DatabaseQueryObservation[] = [];
    const { observer, release } = observationObserver(events);
    const runtime = createDatabaseRuntime(database, { observer });

    await expect(runtime.all(statement)).resolves.toBe(result);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepared.all).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({
      operation: "all",
      status: "success",
      rowsRead: 1,
      physicalPlanHash: null,
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
