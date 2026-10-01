import { describe, expect, it, vi } from "vitest";

import {
  type DatabaseQueryObservation,
  optimizeD1Database,
  registerDatabaseQueryObserver,
} from "@/lib/db";

function createDatabase(run: ReturnType<typeof vi.fn>) {
  const prepared = {
    bind: vi.fn(() => prepared),
    all: vi.fn(async () => ({ success: true, results: [] })),
    first: vi.fn(async () => null),
    run,
  };
  const database = {
    prepare: vi.fn(() => prepared),
  } as unknown as D1Database;
  const observations: DatabaseQueryObservation[] = [];
  registerDatabaseQueryObserver(database, {
    begin({ statementCount }) {
      return {
        statementIndexes: Array.from(
          { length: statementCount },
          (_unused, index) => index,
        ),
        includeBatchSummary: false,
        record(event) {
          observations.push(event);
        },
        release() {},
      };
    },
  });
  return { database, prepared, observations };
}

describe("fixed D1 maintenance operation", () => {
  it("executes one observed PRAGMA optimize run and preserves its D1 result", async () => {
    const result = {
      success: true,
      meta: { changes: 0 },
    } as D1Result;
    const fixture = createDatabase(vi.fn(async () => result));

    await expect(optimizeD1Database(fixture.database)).resolves.toBe(result);

    expect(fixture.database.prepare).toHaveBeenCalledExactlyOnceWith(
      "PRAGMA optimize",
    );
    expect(fixture.prepared.bind).not.toHaveBeenCalled();
    expect(fixture.prepared.run).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.observations[0]).toMatchObject({
      operation: "run",
      tag: "scheduled_tasks.maintenance.optimize",
      status: "success",
      physicalPlanHash: null,
    });
  });

  it("propagates an optimize failure after recording it under the fixed tag", async () => {
    const error = new Error("maintenance failed");
    const fixture = createDatabase(vi.fn(async () => Promise.reject(error)));

    await expect(optimizeD1Database(fixture.database)).rejects.toBe(error);

    expect(fixture.database.prepare).toHaveBeenCalledExactlyOnceWith(
      "PRAGMA optimize",
    );
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.observations[0]).toMatchObject({
      operation: "run",
      tag: "scheduled_tasks.maintenance.optimize",
    });
    expect(fixture.observations[0]?.status).not.toBe("success");
  });
});
