import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  and,
  compileD1Query,
  eq,
  filter,
  inSubquery,
  not,
  param,
  project,
  recursiveClosure,
  scalar,
  valuesRelation,
} from "@/lib/db";
import type { ExpressionValue } from "@/lib/db/query/expression";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

function assertValuesRelationTypes(): void {
  const schema = {
    required: { affinity: "text", nullable: false },
    optional: { affinity: "text", nullable: true },
  } as const;
  const relation = valuesRelation(schema, [
    { required: "key", optional: null },
  ]);
  type RequiredFieldIsString = Assert<
    Equal<ExpressionValue<typeof relation.columns.required>, string>
  >;
  type OptionalFieldIncludesNull = Assert<
    Equal<ExpressionValue<typeof relation.columns.optional>, string | null>
  >;
  const checks: [RequiredFieldIsString, OptionalFieldIncludesNull] = [
    true,
    true,
  ];
  void checks;

  // @ts-expect-error Non-nullable text fields reject null at the API boundary.
  valuesRelation(schema, [{ required: null, optional: null }]);
  // @ts-expect-error Rows have the exact schema shape.
  valuesRelation(schema, [{ required: "key", optional: null, extra: "x" }]);

  const integerSchema = {
    required: { affinity: "integer", nullable: false },
  } as const;
  // @ts-expect-error Text row relation schemas only admit text affinity.
  valuesRelation(integerSchema, [{ required: "key" }]);

  const numberRow = { required: 42, optional: null } as const;
  const booleanRow = { required: "key", optional: true } as const;
  const blobRow = {
    required: "key",
    optional: new Uint8Array([1]),
  } as const;
  // @ts-expect-error Numeric cells are not text row values.
  valuesRelation(schema, [numberRow]);
  // @ts-expect-error Boolean cells are not text row values.
  valuesRelation(schema, [booleanRow]);
  // @ts-expect-error BLOB cells are not text row values.
  valuesRelation(schema, [blobRow]);
}

void assertValuesRelationTypes;

type ResultRow = Record<string, unknown>;

function executeAll(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): ResultRow[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as ResultRow[];
}

function executeValuesOracle(
  db: DatabaseSync,
  fields: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): ResultRow[] {
  if (rows.length === 0) return [];

  const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const names = fields.map(quoteIdentifier).join(", ");
  const tuple = `(${fields.map(() => "?").join(", ")})`;
  const values = rows.map(() => tuple).join(", ");
  const selected = fields.map(quoteIdentifier).join(", ");
  const sql = `WITH "oracle" (${names}) AS (VALUES ${values}) SELECT ${selected} FROM "oracle"`;
  const bindings = rows.flatMap((row) => [...row]) as SQLInputValue[];
  return db.prepare(sql).all(...bindings) as ResultRow[];
}

function normalizeRows(
  rows: readonly ResultRow[],
  fields: readonly string[],
): Array<readonly unknown[]> {
  return rows
    .map((row) => fields.map((field) => row[field]))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

describe("typed text row relations", () => {
  it("matches an independent SQLite VALUES oracle and preserves tuple pairing and bag semantics", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = {
        row_id: { affinity: "text", nullable: false },
        maybe_text: { affinity: "text", nullable: true },
        note: { affinity: "text", nullable: false },
      } as const;
      const rows = [
        { row_id: "left-a", maybe_text: "", note: "empty optional value" },
        { row_id: "right-a", maybe_text: null, note: "literal NULL-like text" },
        {
          row_id: "left-b",
          maybe_text: " \u00a0x\u00a0 ",
          note: "雪 / 🧭 / e\u0301",
        },
        {
          row_id: "right-b",
          maybe_text: "inside\0nul",
          note: "'single' \"double\" \\\\ slash\nline\r\nend",
        },
        {
          row_id: "sql-looking",
          maybe_text: "x'); DROP TABLE oracle; --",
          note: "? ; SELECT 'still data'",
        },
        { row_id: "left-a", maybe_text: "", note: "empty optional value" },
      ] as const;
      const relation = valuesRelation(schema, rows);
      const compiled = compileD1Query(relation);
      const oracle = executeValuesOracle(
        db,
        ["row_id", "maybe_text", "note"],
        rows.map((row) => [row.row_id, row.maybe_text, row.note]),
      );
      const actual = executeAll(db, compiled);

      expect(normalizeRows(actual, ["row_id", "maybe_text", "note"])).toEqual(
        normalizeRows(oracle, ["row_id", "maybe_text", "note"]),
      );
      expect(actual).toHaveLength(rows.length);
      expect(actual.filter((row) => row.row_id === "left-a")).toHaveLength(2);
      expect(actual.find((row) => row.row_id === "right-a")).toMatchObject({
        maybe_text: null,
        note: "literal NULL-like text",
      });
    } finally {
      db.close();
    }
  });

  it("retains an empty relation's declared columns and returns no rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const relation = valuesRelation(
        {
          required: { affinity: "text", nullable: false },
          optional: { affinity: "text", nullable: true },
        } as const,
        [],
      );
      const compiled = compileD1Query(relation);
      const statement = db.prepare(compiled.sql);

      expect(statement.columns().map((column) => column.name)).toEqual([
        "required",
        "optional",
      ]);
      expect(executeAll(db, compiled)).toEqual([]);
      expect(compiled.bindings ?? []).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("packs text rows into JSON when native cells exceed the binding budget", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = {
        left: { affinity: "text", nullable: false },
        middle: { affinity: "text", nullable: false },
        right: { affinity: "text", nullable: false },
      } as const;
      const rows = Array.from({ length: 34 }, (_unused, index) => ({
        left: `left-${index}`,
        middle: `middle-${index}`,
        right: `right-${index}`,
      }));
      const relation = valuesRelation(schema, rows);
      const compiled = compileD1Query(relation);
      const expectedTuples = rows.map((row) => [
        row.left,
        row.middle,
        row.right,
      ]);
      const oracle = executeValuesOracle(
        db,
        ["left", "middle", "right"],
        expectedTuples,
      );

      expect(compiled.bindings).toEqual([JSON.stringify(expectedTuples)]);
      expect(compiled.physicalPlanShape).toMatchObject({
        version: 2,
        nativeRowRelationCount: 0,
        jsonRowRelationCount: 1,
      });
      expect(
        normalizeRows(executeAll(db, compiled), ["left", "middle", "right"]),
      ).toEqual(normalizeRows(oracle, ["left", "middle", "right"]));
    } finally {
      db.close();
    }
  });

  it("splits 20,000 three-column rows at complete tuple boundaries", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = {
        first: { affinity: "text", nullable: false },
        second: { affinity: "text", nullable: false },
        third: { affinity: "text", nullable: false },
      } as const;
      const rows = Array.from({ length: 20_000 }, (_unused, index) => ({
        first: "11111111-1111-1111-1111-111111111111",
        second: "event",
        third: `${index.toString().padStart(8, "0")}-2222-2222-2222-222222222222`,
      }));
      const expectedTuples = rows.map((row) => [
        row.first,
        row.second,
        row.third,
      ]);
      const compiled = compileD1Query(valuesRelation(schema, rows));
      const bindings = compiled.bindings ?? [];
      db.exec(
        'CREATE TEMP TABLE "oracle" ("first" TEXT, "second" TEXT, "third" TEXT)',
      );
      const insertOracleRow = db.prepare(
        'INSERT INTO "oracle" ("first", "second", "third") VALUES (?, ?, ?)',
      );
      for (const row of rows)
        insertOracleRow.run(row.first, row.second, row.third);
      const oracle = db
        .prepare('SELECT "first", "second", "third" FROM "oracle"')
        .all() as ResultRow[];

      expect(bindings).toHaveLength(2);
      expect(
        bindings.every(
          (binding) =>
            typeof binding === "string" &&
            new TextEncoder().encode(binding).byteLength <= 1_000_000,
        ),
      ).toBe(true);
      expect(compiled.physicalPlanShape).toMatchObject({
        version: 2,
        nativeRowRelationCount: 0,
        jsonRowRelationCount: 1,
      });

      const packedTuples = (bindings as readonly string[]).flatMap(
        (segment) => JSON.parse(segment) as Array<readonly string[]>,
      );
      expect(packedTuples).toEqual(expectedTuples);
      expect(packedTuples).toHaveLength(20_000);
      expect(
        normalizeRows(executeAll(db, compiled), ["first", "second", "third"]),
      ).toEqual(normalizeRows(oracle, ["first", "second", "third"]));
    } finally {
      db.close();
    }
  });

  it("keeps SQL three-valued equality and composes typed filters and projections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const relation = valuesRelation(
        {
          value: { affinity: "text", nullable: true },
          group_name: { affinity: "text", nullable: false },
        } as const,
        [
          { value: "x", group_name: "keep" },
          { value: "x", group_name: "keep" },
          { value: "", group_name: "keep" },
          { value: null, group_name: "keep" },
          { value: "x", group_name: "drop" },
        ] as const,
      );
      const equality = eq(relation.columns.value, param("x"));
      const compared = project(relation, {
        value: relation.columns.value,
        equal_to_x: equality,
        not_equal_to_x: not(equality),
      });
      const compiled = compileD1Query(
        filter(compared, eq(compared.columns.value, param("x"))),
      );

      expect(
        normalizeRows(executeAll(db, compiled), [
          "value",
          "equal_to_x",
          "not_equal_to_x",
        ]),
      ).toEqual(
        normalizeRows(
          [
            { value: "x", equal_to_x: 1, not_equal_to_x: 0 },
            { value: "x", equal_to_x: 1, not_equal_to_x: 0 },
            { value: "x", equal_to_x: 1, not_equal_to_x: 0 },
          ],
          ["value", "equal_to_x", "not_equal_to_x"],
        ),
      );

      const allCompared = executeAll(db, compileD1Query(compared));
      expect(allCompared).toContainEqual({
        value: null,
        equal_to_x: null,
        not_equal_to_x: null,
      });
      expect(allCompared).toContainEqual({
        value: "",
        equal_to_x: 0,
        not_equal_to_x: 1,
      });
    } finally {
      db.close();
    }
  });

  it("walks text row leaves through subqueries, scalar expressions, and recursive closure", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const outer = valuesRelation(
        { key: { affinity: "text", nullable: false } } as const,
        [{ key: "a" }, { key: "b" }, { key: "a" }] as const,
      );
      const members = valuesRelation(
        { member: { affinity: "text", nullable: false } } as const,
        [{ member: "a" }, { member: "c" }] as const,
      );
      const scalarSource = valuesRelation(
        { label: { affinity: "text", nullable: false } } as const,
        [{ label: "from-scalar" }] as const,
      );
      const subqueryAndScalar = compileD1Query(
        project(outer, {
          key: outer.columns.key,
          included: inSubquery(outer.columns.key, members),
          scalar_value: scalar(scalarSource),
        }),
      );

      expect(
        normalizeRows(executeAll(db, subqueryAndScalar), [
          "key",
          "included",
          "scalar_value",
        ]),
      ).toEqual(
        normalizeRows(
          [
            { key: "a", included: 1, scalar_value: "from-scalar" },
            { key: "b", included: 0, scalar_value: "from-scalar" },
            { key: "a", included: 1, scalar_value: "from-scalar" },
          ],
          ["key", "included", "scalar_value"],
        ),
      );

      const edges = valuesRelation(
        {
          namespace: { affinity: "text", nullable: false },
          node_id: { affinity: "text", nullable: false },
          parent_id: { affinity: "text", nullable: true },
        } as const,
        [
          { namespace: "walk", node_id: "1", parent_id: "2" },
          { namespace: "walk", node_id: "2", parent_id: "3" },
          { namespace: "walk", node_id: "3", parent_id: null },
        ] as const,
      );
      const seed = filter(edges, eq(edges.columns.node_id, param("1")));
      const closure = recursiveClosure(seed, edges, (current, candidate) =>
        and(
          eq(current.namespace, candidate.namespace),
          eq(current.parent_id, candidate.node_id),
        ),
      );
      const closureQuery = compileD1Query(closure);

      expect(closureQuery.sql).toContain("WITH RECURSIVE");
      expect(
        normalizeRows(executeAll(db, closureQuery), [
          "namespace",
          "node_id",
          "parent_id",
        ]),
      ).toEqual(
        normalizeRows(
          [
            { namespace: "walk", node_id: "1", parent_id: "2" },
            { namespace: "walk", node_id: "2", parent_id: "3" },
            { namespace: "walk", node_id: "3", parent_id: null },
          ],
          ["namespace", "node_id", "parent_id"],
        ),
      );
    } finally {
      db.close();
    }
  });

  it("snapshots schema order and row cells at construction", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema: {
        key: { affinity: "text"; nullable: false };
        extra: { affinity: "text"; nullable: true };
      } = {
        key: { affinity: "text", nullable: false },
        extra: { affinity: "text", nullable: true },
      };
      const rows: Array<{ key: string; extra: string | null }> = [
        { key: "before", extra: null },
      ];
      const relation = valuesRelation(schema, rows);

      rows[0]!.key = "after";
      rows.push({ key: "appended", extra: "new row" });
      Object.assign(rows[0]!, { injected: "extra property" });
      Reflect.deleteProperty(schema, "key");
      Object.assign(schema, {
        key: { affinity: "text" as const, nullable: false },
      });

      const compiled = compileD1Query(relation);
      expect(
        db
          .prepare(compiled.sql)
          .columns()
          .map((column) => column.name),
      ).toEqual(["key", "extra"]);
      expect(executeAll(db, compiled)).toEqual([
        { key: "before", extra: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects malformed schemas and rows at the constructor boundary", () => {
    expect(() => valuesRelation({} as never, [])).toThrow();
    expect(() => valuesRelation([] as never, [])).toThrow();
    const symbolField = Symbol("hidden");
    expect(() =>
      valuesRelation(
        {
          required: { affinity: "text", nullable: false },
          [symbolField]: { affinity: "text", nullable: false },
        } as never,
        [],
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { value: { affinity: "integer", nullable: false } } as never,
        [{ value: "text" }] as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        null as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        {
          required: { affinity: "text", nullable: false },
          optional: { affinity: "text", nullable: true },
        } as const,
        [{ required: "present" }] as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        [{ required: "present", unexpected: "extra" }] as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        [{ required: null }] as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        [{ required: "\uD800" }] as never,
      ),
    ).toThrow();
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        [{ required: "\uDC00" }] as never,
      ),
    ).toThrow();

    const decoratedRows = [{ required: "valid" }];
    Object.assign(decoratedRows, { extra: true });
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        decoratedRows,
      ),
    ).toThrow();

    const sparseRows = new Array<{ required: string }>(2);
    sparseRows[0] = { required: "valid" };
    Object.assign(sparseRows, { extra: true });
    expect(() =>
      valuesRelation(
        { required: { affinity: "text", nullable: false } } as const,
        sparseRows,
      ),
    ).toThrow();
  });
});
