import { describe, expect, it, vi } from "vitest";

import { createDatabaseRuntime } from "@/lib/db";

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
  };
  const database = {
    prepare: vi.fn(() => prepared),
  } as unknown as D1Database;

  return { database, prepared, result, row };
}

describe("D1 database runtime", () => {
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

  it("propagates the original D1 error", async () => {
    const error = new Error("D1 failed");
    const { database, prepared } = createDatabase();
    prepared.all.mockRejectedValue(error);

    await expect(
      createDatabaseRuntime(database).all({ sql: "SELECT 1" }),
    ).rejects.toBe(error);
  });
});
