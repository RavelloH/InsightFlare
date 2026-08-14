import { describe, expect, it, vi } from "vitest";

import { observeD1 } from "@/lib/edge/performance-observed-d1";
import { createPerformanceQueryObserver } from "@/lib/edge/performance-query-observer";

function result<T>(results: T[], rowsRead = 0): D1Result<T> {
  return {
    results,
    success: true,
    meta: {
      changed_db: false,
      changes: 0,
      duration: 0,
      last_row_id: 0,
      rows_read: rowsRead,
      rows_written: 0,
      size_after: 0,
    },
  };
}

function database() {
  const statement = {
    all: vi.fn(async () => result([{ id: "row" }], 12)),
    bind: vi.fn(function bind() {
      return statement;
    }),
    first: vi.fn(async () => ({ id: "row" })),
    raw: vi.fn(async () => [["row"]]),
    run: vi.fn(async () => result([], 3)),
  };
  return {
    batch: vi.fn(async () => [result([], 4)]),
    exec: vi.fn(async () => ({ count: 1, duration: 0 })),
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

describe("observeD1", () => {
  it("accounts for all() and probe rows", async () => {
    const observer = createPerformanceQueryObserver("journey-v2", "list");
    const db = observeD1(database(), observer);

    await db.prepare("SELECT 1").bind("site").all();
    await db.probe(async () => result([], 5));

    expect(observer).toMatchObject({
      d1QueryCount: 2,
      d1RowsRead: 17,
      rowsReadAvailable: true,
    });
  });

  it("marks all unsupported result forms unavailable", async () => {
    const observer = createPerformanceQueryObserver("task-v2", "groups");
    const rawDatabase = database();
    const db = observeD1(rawDatabase, observer);
    const statement = db.prepare("SELECT 1");

    await statement.first();
    await statement.run();
    await statement.raw();
    await db.batch([statement, db.prepare("SELECT 2")]);
    await db.exec("PRAGMA table_info(test)");

    expect(observer).toMatchObject({
      d1QueryCount: 6,
      rowsReadAvailable: false,
    });
    expect(rawDatabase.batch).toHaveBeenCalledTimes(1);
  });
});
