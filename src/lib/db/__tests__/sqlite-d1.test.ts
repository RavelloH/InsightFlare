import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteD1Database } from "./sqlite-d1";

const databases = new Set<DatabaseSync>();

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  return database;
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("SQLite D1 row adaptation", () => {
  it("preserves BLOB bytes and adapts BigInt only when requested", async () => {
    const defaultDb = createSqliteD1Database(createDatabase(), {
      preparedSql: [],
      bindings: [],
    });
    const defaultRows = await defaultDb
      .prepare("SELECT X'00FF11' AS payload")
      .all<{ payload: Uint8Array }>();
    expect(defaultRows.results[0]?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(defaultRows.results[0]?.payload ?? [])).toEqual([
      0, 255, 17,
    ]);

    const sql =
      "SELECT CAST('-9223372036854775808' AS INTEGER) AS large_integer, X'00FF11' AS payload";
    const numericDb = createSqliteD1Database(createDatabase(), {
      preparedSql: [],
      bindings: [],
      readBigIntsAsNumbers: true,
    });
    const allRows = await numericDb.prepare(sql).all<{
      large_integer: number;
      payload: Uint8Array;
    }>();
    const firstRow = await numericDb.prepare(sql).first<{
      large_integer: number;
      payload: Uint8Array;
    }>();

    for (const row of [allRows.results[0], firstRow]) {
      expect(row?.large_integer).toBe(-9223372036854775808);
      expect(row?.payload).toBeInstanceOf(Uint8Array);
      expect(Array.from(row?.payload ?? [])).toEqual([0, 255, 17]);
    }
  });
});
