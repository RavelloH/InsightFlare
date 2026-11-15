// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import {
  createRemoteD1Database,
  type RemoteStatementMeta,
} from "./remote-d1-database";

interface Payload {
  sql: string;
  params: SQLInputValue[];
}

afterEach(() => vi.unstubAllGlobals());

function restSqliteFixture() {
  const sqlite = new DatabaseSync(":memory:");
  const payloads: Payload[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Payload | Payload[];
      const statements = Array.isArray(body) ? body : [body];
      payloads.push(statements);
      return new Response(
        JSON.stringify({
          success: true,
          result: statements.map(({ sql, params }) => ({
            // The live D1 probe observed JSON true bound as TEXT 'true'.
            // Model that REST boundary before evaluating actual SQLite CASEs.
            results: sqlite
              .prepare(sql)
              .all(
                ...params.map((value) =>
                  typeof value === "boolean" ? String(value) : value,
                ),
              ),
            meta: {
              rows_read: 0,
              rows_written: 0,
              timings: { sql_duration_ms: 1 },
            },
          })),
        }),
      );
    }),
  );
  const metas: RemoteStatementMeta[] = [];
  const db = createRemoteD1Database({
    accountId: "test",
    databaseId: "test",
    token: "test-only",
    onStatement: (meta) => metas.push(meta),
  });
  return { sqlite, payloads, metas, db };
}

it("normalizes boolean REST bindings before evaluating visit observation counts", async () => {
  const { sqlite, payloads, metas, db } = restSqliteFixture();
  try {
    // A missing normalization must fail the actual aggregate, rather than
    // merely a payload-shape assertion: SQLite treats TEXT 'true' as false.
    const sql =
      "SELECT SUM(CASE WHEN observation THEN 1 ELSE 0 END) AS views FROM (SELECT ? AS observation UNION ALL SELECT ?)";
    expect(sqlite.prepare(sql).get("true", "false")).toEqual({ views: 0 });
    const original = [true, false];
    expect(
      (
        await db
          .prepare(sql)
          .bind(...original)
          .all()
      ).results,
    ).toEqual([{ views: 1 }]);
    expect(payloads[0]?.[0]?.params).toEqual([1, 0]);
    expect(original).toEqual([true, false]);
    expect(metas[0]).toMatchObject({
      inputParams: [true, false],
      params: [1, 0],
      parameterCount: 2,
      statementOrdinal: 1,
    });
  } finally {
    sqlite.close();
  }
});

it("normalizes each batch binding while preserving other scalar values and ordinals", async () => {
  const { sqlite, payloads, metas, db } = restSqliteFixture();
  try {
    const results = await db.batch([
      db.prepare("SELECT CASE WHEN ? THEN 1 ELSE 0 END AS value").bind(true),
      db
        .prepare("SELECT ? AS flag, ? AS numeric, ? AS text, ? AS empty")
        .bind(false, 1.5, "true", null),
    ]);
    expect(results.map((result) => result.results)).toEqual([
      [{ value: 1 }],
      [{ flag: 0, numeric: 1.5, text: "true", empty: null }],
    ]);
    expect(payloads[0]?.map((statement) => statement.params)).toEqual([
      [1],
      [0, 1.5, "true", null],
    ]);
    expect(
      metas.map(({ inputParams, params, statementOrdinal }) => ({
        inputParams,
        params,
        statementOrdinal,
      })),
    ).toEqual([
      { inputParams: [true], params: [1], statementOrdinal: 1 },
      {
        inputParams: [false, 1.5, "true", null],
        params: [0, 1.5, "true", null],
        statementOrdinal: 2,
      },
    ]);
  } finally {
    sqlite.close();
  }
});
