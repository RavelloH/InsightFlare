// @vitest-environment node

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  type AdaptiveQueryLayout,
  registerAdaptiveQueryExecutionForCompiler,
} from "@/lib/db/query/adaptive-execution";
import {
  createD1DatabaseClient,
  createDatabaseClient,
} from "@/lib/db/query/client";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import type {
  DatabaseQueryObservation,
  DatabaseRuntime,
  DatabaseStatement,
} from "@/lib/db/types";

const layout: AdaptiveQueryLayout = {
  tagField: "_tag",
  guardField: "_guard",
  ordinalField: "_ordinal",
  fields: ["id", "payload"],
};
function control(guard: 0 | 1) {
  return { _tag: 0, _guard: guard, _ordinal: 0, id: null, payload: null };
}
function row(id: unknown, payload: unknown, ordinal = 1) {
  return { _tag: 1, _guard: null, _ordinal: ordinal, id, payload };
}
function result(rows: unknown[], meta: Record<string, unknown> = {}) {
  return {
    success: true,
    results: rows,
    meta: { rows_read: 3, rows_written: 0, duration: 2.5, ...meta },
  } as D1Result<Record<string, unknown>>;
}
function setup(responses: (D1Result | Error | (() => D1Result))[]) {
  const original: CompiledQuery = {
    kind: "query",
    sql: "SELECT id, payload FROM original WHERE key = ?",
    bindings: ["key"],
    tag: "original",
  };
  const probe: CompiledQuery = {
    kind: "query",
    sql: "SELECT private_guard_and_fast",
  };
  registerAdaptiveQueryExecutionForCompiler(original, { query: probe, layout });
  const all = vi.fn(async (_query: DatabaseStatement) => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (typeof value === "function") return value();
    if (!value) throw new Error("unexpected extra statement");
    return value;
  });
  const runtime = {
    all,
    first: vi.fn(async () => ({ id: "first" })),
    run: vi.fn(async () => result([])),
    batch: vi.fn(async () => []),
    exec: vi.fn(),
  } as unknown as DatabaseRuntime;
  return {
    original,
    probe,
    all,
    runtime,
    client: createDatabaseClient(runtime),
  };
}

describe("private adaptive query execution", () => {
  it("preserves ordinary values and row order, executes no original SQL on true", async () => {
    const blob = new Uint8Array([0, 255, 1]);
    const f = setup([result([control(1), row("a", blob), row("b", null, 2)])]);
    const value = await f.client.all(f.original);
    expect(value.results).toEqual([
      { id: "a", payload: blob },
      { id: "b", payload: null },
    ]);
    expect(value.results[0]!.payload).toBe(blob);
    expect(f.all.mock.calls.map(([q]) => q.sql)).toEqual([f.probe.sql]);
    expect(value.meta.rows_read).toBe(3);
    expect(f.original.sql).toBe(
      "SELECT id, payload FROM original WHERE key = ?",
    );
  });

  it("distinguishes true-empty from false and reads exact original SQL only on false", async () => {
    const empty = setup([result([control(1)])]);
    expect((await empty.client.all(empty.original)).results).toEqual([]);
    expect(empty.all).toHaveBeenCalledTimes(1);
    const f = setup([
      result([control(0)]),
      result([{ id: "old", payload: 17 }]),
    ]);
    expect((await f.client.all(f.original)).results).toEqual([
      { id: "old", payload: 17 },
    ]);
    expect(
      f.all.mock.calls.map(([q]) => ({
        sql: q.sql,
        bindings: q.bindings,
        tag: q.tag,
      })),
    ).toEqual([
      { sql: f.probe.sql, bindings: undefined, tag: undefined },
      { sql: f.original.sql, bindings: ["key"], tag: "original" },
    ]);
  });

  it("combines all physical cost and retains only final nonadditive metadata", async () => {
    const f = setup([
      result([control(0)], {
        rows_read: 7,
        duration: 1.25,
        size_after: 1,
        timings: { sql_duration_ms: 0.5 },
      }),
      result([{ id: "old", payload: null }], {
        rows_read: 19,
        duration: 2.75,
        size_after: 42,
        served_by: "final",
        timings: { sql_duration_ms: 1.5, other: "kept" },
      }),
    ]);
    const value = await f.client.all(f.original);
    expect(value.meta).toEqual({
      rows_read: 26,
      rows_written: 0,
      duration: 4,
      size_after: 42,
      served_by: "final",
      timings: { sql_duration_ms: 2, other: "kept" },
    });
  });

  it.each([undefined, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])(
    "does not invent missing/invalid or overflowing cost (%s)",
    async (bad) => {
      const f = setup([
        result([control(0)], {
          rows_read: bad,
          rows_written: bad,
          duration: bad,
          timings: { sql_duration_ms: bad },
        }),
        result([], {
          rows_read: 2,
          rows_written: 2,
          timings: { sql_duration_ms: 1 },
        }),
      ]);
      const meta = (await f.client.all(f.original)).meta;
      expect(meta).not.toHaveProperty("rows_read");
      expect(meta).not.toHaveProperty("rows_written");
      if (bad !== Number.MAX_SAFE_INTEGER) {
        expect(meta).not.toHaveProperty("duration");
        expect(
          (meta as unknown as { timings: object }).timings,
        ).not.toHaveProperty("sql_duration_ms");
      }
    },
  );

  it.each([
    [],
    [control(1), control(1)],
    [row("a", null), control(1)],
    [control(0), row("a", null)],
    [{ ...control(1), _guard: true }],
    [{ ...control(1), payload: "unexpected" }],
    [{ ...control(1), _ordinal: 1 }],
    [control(1), row("a", null, 2)],
    [control(1), { ...row("a", null), _guard: 1 }],
    [control(1), { ...row("a", null), extra: "leak" }],
    [control(1), { _tag: 1, _guard: null, _ordinal: 1, id: "a" }],
    [control(1), { ...row("a", null), _tag: 2 }],
    [null],
  ])(
    "rejects corrupt envelope without executing fallback %#",
    async (...rows) => {
      const f = setup([result(rows)]);
      await expect(f.client.all(f.original)).rejects.toThrow(
        "database_adaptive_query_protocol_invalid",
      );
      expect(f.all).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates thrown database errors by identity and preserves failure results", async () => {
    const error = new Error("database failed");
    const f = setup([error]);
    await expect(f.client.all(f.original)).rejects.toBe(error);
    expect(f.all).toHaveBeenCalledTimes(1);
    const failure = {
      ...result([]),
      success: false,
      error: "failed",
    } as unknown as D1Result;
    const failed = setup([failure]);
    expect(await failed.client.all(failed.original)).toBe(failure);
    expect(failed.all).toHaveBeenCalledTimes(1);
    const fallback = setup([result([control(0)]), failure]);
    const returned = await fallback.client.all(fallback.original);
    expect(returned.success).toBe(false);
    expect(returned.meta.rows_read).toBe(6);
  });

  it("uses an untouched fallback snapshot even if public bindings change during the probe", async () => {
    const f = setup([
      () => {
        (f.original.bindings as unknown[])[0] = "changed";
        (f.original as { sql: string }).sql = "SELECT changed";
        return result([control(0)]);
      },
      result([]),
    ]);
    await f.client.all(f.original);
    expect(f.all.mock.calls[1]![0].sql).toBe(
      "SELECT id, payload FROM original WHERE key = ?",
    );
    expect(f.all.mock.calls[1]![0].bindings).toEqual(["key"]);
  });

  it("does not reuse runtime certificates, and clones or mutated queries run ordinary SQL", async () => {
    const f = setup([
      result([control(1)]),
      result([control(0)]),
      result([]),
      result([]),
      result([]),
    ]);
    await f.client.all(f.original);
    await f.client.all(f.original);
    await f.client.all({ ...f.original });
    delete (f.original.bindings as unknown[])[0];
    await f.client.all(f.original);
    expect(f.all.mock.calls.map(([q]) => q.sql)).toEqual([
      f.probe.sql,
      f.probe.sql,
      f.original.sql,
      f.original.sql,
      f.original.sql,
    ]);
  });

  it("keeps first/run/batch on their original runtime path", async () => {
    const f = setup([]);
    expect(await f.client.first(f.original)).toEqual({ id: "first" });
    expect(f.runtime.first).toHaveBeenCalledWith(f.original);
    const mutation = { kind: "mutation", sql: "DELETE FROM example" } as never;
    await f.client.run(mutation);
    await f.client.batch([mutation]);
    expect(f.runtime.run).toHaveBeenCalledWith(mutation);
    expect(f.runtime.batch).toHaveBeenCalledWith([mutation]);
    expect(f.all).not.toHaveBeenCalled();
  });

  it("enforces the compiler protocol and statement budgets before dispatch", () => {
    const query: CompiledQuery = { kind: "query", sql: "SELECT 1" };
    expect(() =>
      registerAdaptiveQueryExecutionForCompiler(query, {
        query,
        layout: { ...layout, fields: ["_tag"] },
      }),
    ).toThrow("protocol_invalid");
    expect(() =>
      registerAdaptiveQueryExecutionForCompiler(query, {
        query: { ...query, sql: " ".repeat(110000) },
        layout,
      }),
    ).toThrow();
    registerAdaptiveQueryExecutionForCompiler(query, { query, layout });
    expect(() =>
      registerAdaptiveQueryExecutionForCompiler(query, { query, layout }),
    ).toThrow("already_registered");
  });

  it.each([false, true])(
    "owns private binary bindings through a probe/fallback await (shared=%s)",
    async (shared) => {
      const bytes = new Uint8Array(
        shared ? new SharedArrayBuffer(2) : new ArrayBuffer(2),
      );
      bytes.set([7, 9]);
      const original: CompiledQuery = {
        kind: "query",
        sql: "SELECT ?",
        bindings: [bytes],
      };
      const probe: CompiledQuery = {
        kind: "query",
        sql: "SELECT private",
        bindings: [bytes],
      };
      registerAdaptiveQueryExecutionForCompiler(original, {
        query: probe,
        layout,
      });
      const seen: number[][] = [];
      const runtime = {
        all: vi.fn(async (query: DatabaseStatement) => {
          const binding = query.bindings![0] as ArrayBuffer | ArrayBufferView;
          seen.push([
            ...new Uint8Array(
              binding instanceof ArrayBuffer ? binding : binding.buffer,
            ),
          ]);
          if (seen.length === 1) {
            bytes.set([99, 99]);
            return result([control(0)]);
          }
          return result([]);
        }),
      } as unknown as DatabaseRuntime;
      await createDatabaseClient(runtime).all(original);
      expect(seen).toEqual([
        [7, 9],
        [7, 9],
      ]);
      await createDatabaseClient(runtime).all(original);
      expect(seen[2]).toEqual([99, 99]);
    },
  );

  it("snapshots the private query/layout and declines changed physical metadata", async () => {
    const f = setup([result([control(1)]), result([]), result([])]);
    (f.probe as { sql: string }).sql = "SELECT altered_private";
    await f.client.all(f.original);
    expect(f.all.mock.calls[0]![0].sql).toBe("SELECT private_guard_and_fast");
    const shape: Record<string, unknown> = {};
    shape.self = shape;
    (f.original as unknown as { physicalPlanShape: object }).physicalPlanShape =
      shape;
    await f.client.all(f.original);
    expect(f.all.mock.calls[1]![0]).toBe(f.original);
    delete (f.original as unknown as { physicalPlanShape?: object })
      .physicalPlanShape;
    (f.original as unknown as { kind: string }).kind = "changed";
    await f.client.all(f.original);
    expect(f.all.mock.calls[2]![0]).toBe(f.original);
  });

  it.each([
    { ...layout, guardField: "_TAG" },
    { ...layout, fields: ["ID", "id"] },
  ])("rejects case-insensitive protocol field collisions", (ambiguous) => {
    const query: CompiledQuery = { kind: "query", sql: "SELECT 1" };
    expect(() =>
      registerAdaptiveQueryExecutionForCompiler(query, {
        query,
        layout: ambiguous,
      }),
    ).toThrow("database_adaptive_query_protocol_invalid");
  });

  it("executes real SQLite fallback unwrapped after a concurrent write, observing both statements", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE original (id TEXT, payload BLOB); INSERT INTO original VALUES ('before', X'00FF')",
      );
      const original: CompiledQuery = {
        kind: "query",
        sql: "SELECT id, payload FROM original ORDER BY id",
      };
      const trace = { preparedSql: [] as string[], bindings: [] };
      const native = createSqliteD1Database(db, trace);
      const d1 = Object.create(native) as D1Database;
      d1.prepare = (sql: string) => {
        if (sql === original.sql) db.exec("UPDATE original SET id = 'after'");
        return native.prepare(sql);
      };
      const observations: DatabaseQueryObservation[] = [];
      const runtimeClient = createD1DatabaseClient(d1, {
        observer: {
          begin: () => ({
            statementIndexes: [0],
            includeBatchSummary: false,
            record: (value) => {
              observations.push(value);
            },
            release: () => {},
          }),
        },
      });
      const probe: CompiledQuery = {
        kind: "query",
        sql: "SELECT 0 AS _tag, 0 AS _guard, 0 AS _ordinal, NULL AS id, NULL AS payload",
      };
      registerAdaptiveQueryExecutionForCompiler(original, {
        query: probe,
        layout,
      });
      const result = await runtimeClient.all(original);
      expect(result.results).toEqual([
        { id: "after", payload: new Uint8Array([0, 255]) },
      ]);
      expect(trace.preparedSql).toEqual([probe.sql, original.sql]);
      expect(
        observations.map(({ operation, status }) => ({ operation, status })),
      ).toEqual([
        { operation: "all", status: "success" },
        { operation: "all", status: "success" },
      ]);
      expect(result.meta).not.toHaveProperty("rows_read");
      expect(result.success).toBe(true);
    } finally {
      db.close();
    }
  });
});
