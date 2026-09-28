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
    run: vi.fn(async () => result),
  };
  const database = {
    prepare: vi.fn(() => prepared),
    batch: vi.fn(async () => [result]),
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
