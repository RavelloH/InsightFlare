import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  compileD1Query,
  count,
  eq,
  filter,
  gt,
  lt,
  param,
  project,
  scan,
  semiJoin,
  sum,
  valuesRelation,
  window,
  windowCountRows,
} from "@/lib/db";
import {
  compileD1QuerySemiMembershipFallbackForTest,
  compileD1QuerySemiMembershipForceSafeForTest,
} from "@/lib/db/query/compiler";
import type {
  ColumnExpression,
  ExpressionResultType,
} from "@/lib/db/query/expression";
import type { AnyExpression } from "@/lib/db/query/expression";
import { semiMembershipComparisonDomain } from "@/lib/db/query/physical/comparison-domains";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaTableReference } from "@/lib/db/schema/types";

const textCatalog = (name: string, defaultCollation: "BINARY" | "unknown") =>
  ({
    kind: "table",
    name,
    defaultCollation,
    columns: {
      site_pk: {
        kind: "column",
        table: name,
        sqlName: "site_pk",
        propertyName: "site_pk",
        declaredType: "INTEGER",
        affinity: "integer",
        nullable: false,
        rowidAlias: true,
        primaryKeyPosition: 1,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
      site_id: {
        kind: "column",
        table: name,
        sqlName: "site_id",
        propertyName: "site_id",
        declaredType: "TEXT",
        affinity: "text",
        nullable: true,
        primaryKeyPosition: 0,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
      visitor_id: {
        kind: "column",
        table: name,
        sqlName: "visitor_id",
        propertyName: "visitor_id",
        declaredType: "TEXT",
        affinity: "text",
        nullable: true,
        primaryKeyPosition: 0,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
    },
    primaryKey: ["site_pk"],
    indexes: [],
    foreignKeys: [],
  }) as const satisfies SchemaTableReference;

type TestRelation = Relation<
  Record<string, unknown>,
  Readonly<Record<string, AnyExpression>>
>;

const registeredTables = new Set<string>();

function relation(table: SchemaTableReference): TestRelation {
  const mutableSchema = schema as unknown as Record<string, unknown>;
  mutableSchema[table.name] = table;
  registeredTables.add(table.name);
  return scan(
    table as unknown as typeof schema.site_identities,
  ) as unknown as TestRelation;
}

function valueColumn(source: TestRelation, name: string) {
  return (source.columns as unknown as Record<string, unknown>)[name] as never;
}

function integerColumn(source: TestRelation) {
  return (source.columns as unknown as Record<string, unknown>)[
    "site_pk"
  ] as ColumnExpression<number, ExpressionResultType<"integer", false>>;
}

function nullableTextColumn(source: TestRelation, name = "site_id") {
  return (source.columns as unknown as Record<string, unknown>)[
    name
  ] as ColumnExpression<string | null, ExpressionResultType<"text", true>>;
}

function sortedRows(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  const rows = db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
  const normalize = (value: unknown): unknown =>
    value instanceof Uint8Array ? [...value] : value;
  return rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [name, normalize(value)]),
      ),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function sortedGroupedStorageBytes(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(
      `SELECT hex(grouped.site_id) AS site_id_hex, grouped.row_count FROM (${query.sql}) AS grouped`,
    )
    .all(...((query.bindings ?? []) as SQLInputValue[]))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

describe("Generic SemiJoin text comparison domains", () => {
  afterEach(() => {
    const mutableSchema = schema as unknown as Record<string, unknown>;
    for (const name of registeredTables)
      Reflect.deleteProperty(mutableSchema, name);
    registeredTables.clear();
  });

  it("matches the full BINARY TEXT/BLOB/NULL result for catalog, finite, tuple, and grouped keys", () => {
    const db = new DatabaseSync(":memory:");
    const table = textCatalog("wave97bm_text_domain", "BINARY");
    try {
      db.exec(`CREATE TABLE ${table.name} (
        site_pk INTEGER PRIMARY KEY,
        site_id TEXT COLLATE BINARY,
        visitor_id TEXT COLLATE BINARY
      )`);
      const insert = db.prepare(
        `INSERT INTO ${table.name}(site_pk, site_id, visitor_id) VALUES (?, ?, ?)`,
      );
      const binary = new Uint8Array([0x61, 0x62]);
      const leftValues: readonly [
        number,
        string | Uint8Array | null,
        string,
      ][] = [
        [1, "same", "pair"],
        [2, "same", "pair"],
        [3, "same", "different"],
        [4, "001", "numeric-shaped"],
        [5, "1", "numeric"],
        [6, "", "empty"],
        [7, "café", "unicode"],
        [8, "nul\0tail", "nul"],
        [9, binary, "blob"],
        [10, null, "null"],
        [11, "left-only", "only"],
      ];
      const rightValues: readonly [
        number,
        string | Uint8Array | null,
        string,
      ][] = [
        [101, "same", "pair"],
        [102, "same", "pair"],
        [103, "001", "numeric-shaped"],
        [104, "1", "numeric"],
        [105, "", "empty"],
        [106, "café", "unicode"],
        [107, "nul\0tail", "nul"],
        [108, binary, "blob"],
        [109, null, "null"],
      ];
      for (const [id, key, visitor] of [...leftValues, ...rightValues])
        insert.run(id, key, visitor);

      const leftBase = relation(table);
      const rightBase = relation(table);
      const left = filter(leftBase, lt(integerColumn(leftBase), param(100)));
      const right = filter(rightBase, gt(integerColumn(rightBase), param(100)));
      const scalar = semiJoin(
        left,
        right,
        eq(valueColumn(left, "site_id"), valueColumn(right, "site_id")),
      );
      const scalarDefault = compileD1Query(scalar);
      const scalarCandidate =
        compileD1QuerySemiMembershipForceSafeForTest(scalar);
      const scalarFallback =
        compileD1QuerySemiMembershipFallbackForTest(scalar);
      expect(scalarDefault.sql).toContain("EXISTS");
      expect(scalarDefault.sql).not.toContain(" IN (SELECT ");
      expect(scalarCandidate.sql).toContain(" IN (SELECT ");
      expect(scalarCandidate.physicalPlanShape?.version).toBe(10);
      expect(sortedRows(db, scalarCandidate)).toEqual(
        sortedRows(db, scalarFallback),
      );
      expect(
        sortedRows(db, scalarCandidate)
          .map(({ site_pk }) => site_pk)
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(
        db
          .prepare(
            `SELECT site_pk, typeof(site_id) AS stored_type FROM ${table.name} ORDER BY site_pk`,
          )
          .all(),
      ).toEqual([
        { site_pk: 1, stored_type: "text" },
        { site_pk: 2, stored_type: "text" },
        { site_pk: 3, stored_type: "text" },
        { site_pk: 4, stored_type: "text" },
        { site_pk: 5, stored_type: "text" },
        { site_pk: 6, stored_type: "text" },
        { site_pk: 7, stored_type: "text" },
        { site_pk: 8, stored_type: "text" },
        { site_pk: 9, stored_type: "blob" },
        { site_pk: 10, stored_type: "null" },
        { site_pk: 11, stored_type: "text" },
        { site_pk: 101, stored_type: "text" },
        { site_pk: 102, stored_type: "text" },
        { site_pk: 103, stored_type: "text" },
        { site_pk: 104, stored_type: "text" },
        { site_pk: 105, stored_type: "text" },
        { site_pk: 106, stored_type: "text" },
        { site_pk: 107, stored_type: "text" },
        { site_pk: 108, stored_type: "blob" },
        { site_pk: 109, stored_type: "null" },
      ]);

      const tuple = semiJoin(
        left,
        right,
        and(
          eq(valueColumn(left, "site_id"), valueColumn(right, "site_id")),
          eq(valueColumn(left, "visitor_id"), valueColumn(right, "visitor_id")),
        ),
      );
      const tupleDefault = compileD1Query(tuple);
      const tupleCandidate =
        compileD1QuerySemiMembershipForceSafeForTest(tuple);
      const tupleFallback = compileD1QuerySemiMembershipFallbackForTest(tuple);
      expect(tupleDefault.sql).toContain("EXISTS");
      expect(tupleDefault.sql).not.toContain(" IN (SELECT ");
      expect(tupleCandidate.sql).toContain(" IN (SELECT ");
      expect(sortedRows(db, tupleCandidate)).toEqual(
        sortedRows(db, tupleFallback),
      );
      expect(
        sortedRows(db, tupleCandidate)
          .map(({ site_pk }) => site_pk)
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);

      const finite = valuesRelation(
        { key: { affinity: "text", nullable: true } },
        [
          { key: "same" },
          { key: "001" },
          { key: "1" },
          { key: "" },
          { key: "café" },
          { key: "nul\0tail" },
          { key: null },
        ],
      );
      const finiteSemi = semiJoin(
        left,
        finite as unknown as TestRelation,
        eq(
          valueColumn(left, "site_id"),
          valueColumn(finite as unknown as TestRelation, "key"),
        ),
      );
      const finiteDefault = compileD1Query(finiteSemi);
      const finiteCandidate =
        compileD1QuerySemiMembershipForceSafeForTest(finiteSemi);
      const finiteFallback =
        compileD1QuerySemiMembershipFallbackForTest(finiteSemi);
      expect(finiteDefault.sql).toContain("EXISTS");
      expect(finiteDefault.sql).not.toContain(" IN (SELECT ");
      expect(finiteCandidate.sql).toContain(" IN (SELECT ");
      expect(sortedRows(db, finiteCandidate)).toEqual(
        sortedRows(db, finiteFallback),
      );
      expect(
        sortedRows(db, finiteCandidate)
          .map(({ site_pk }) => site_pk)
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const groupedLeft = aggregate(left, {
        groupBy: { site_id: nullableTextColumn(left) },
        aggregates: { row_count: count() },
      });
      const groupedRight = aggregate(right, {
        groupBy: { site_id: nullableTextColumn(right) },
        aggregates: { row_count: count() },
      });
      const groupedSemi = semiJoin(
        groupedLeft,
        groupedRight,
        eq(groupedLeft.columns.site_id, groupedRight.columns.site_id),
      );
      const groupedCandidate = compileD1Query(groupedSemi);
      const groupedFallback =
        compileD1QuerySemiMembershipFallbackForTest(groupedSemi);
      expect(groupedCandidate.sql).toContain("EXISTS");
      expect(groupedCandidate.sql).not.toContain(" IN (SELECT ");
      expect(sortedGroupedStorageBytes(db, groupedCandidate)).toEqual(
        sortedGroupedStorageBytes(db, groupedFallback),
      );
      expect(sortedGroupedStorageBytes(db, groupedCandidate)).toEqual([
        { site_id_hex: "", row_count: 1 },
        { site_id_hex: "303031", row_count: 1 },
        { site_id_hex: "31", row_count: 1 },
        { site_id_hex: "6162", row_count: 1 },
        { site_id_hex: "636166C3A9", row_count: 1 },
        { site_id_hex: "6E756C007461696C", row_count: 1 },
        { site_id_hex: "73616D65", row_count: 3 },
      ]);

      const groupDomain = semiMembershipComparisonDomain(groupedLeft, 0);
      expect(groupDomain.kind).toBe("proven");
      if (groupDomain.kind === "proven")
        expect(groupDomain.domain.storageClasses).toEqual([
          "blob",
          "null",
          "text",
        ]);
      const computedAggregate = aggregate(left, {
        groupBy: { site_id: nullableTextColumn(left) },
        aggregates: { sum_key: sum(integerColumn(left)) },
      });
      expect(
        semiMembershipComparisonDomain(computedAggregate, 1),
      ).toMatchObject({
        kind: "rejected",
        reason:
          "aggregate output is not a metadata-matched direct GROUP BY column",
      });

      const withWindow = window(left, {
        group_size: windowCountRows({
          partitionBy: [nullableTextColumn(left)],
        }),
      });
      expect(semiMembershipComparisonDomain(withWindow, 0).kind).toBe("proven");
      expect(semiMembershipComparisonDomain(withWindow, 3)).toMatchObject({
        kind: "rejected",
        reason: "computed window output has no comparison-domain proof",
      });

      const emptyRight = filter(
        rightBase,
        lt(integerColumn(rightBase), param(0)),
      );
      const emptySemi = semiJoin(
        left,
        emptyRight,
        eq(valueColumn(left, "site_id"), valueColumn(emptyRight, "site_id")),
      );
      const emptyDefault = compileD1Query(emptySemi);
      const emptyCandidate =
        compileD1QuerySemiMembershipForceSafeForTest(emptySemi);
      const emptyFallback =
        compileD1QuerySemiMembershipFallbackForTest(emptySemi);
      expect(emptyDefault.sql).toContain("EXISTS");
      expect(emptyDefault.sql).not.toContain(" IN (SELECT ");
      expect(emptyCandidate.sql).toContain(" IN (SELECT ");
      expect(sortedRows(db, emptyCandidate)).toEqual(
        sortedRows(db, emptyFallback),
      );
      expect(sortedRows(db, emptyCandidate)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("uses only BINARY metadata and verified text/NULL scalar producers", () => {
    const binaryTable = textCatalog("wave97bm_binary", "BINARY");
    const source = relation(binaryTable);
    const projected = project(
      valuesRelation({ marker: { affinity: "text", nullable: false } }, [
        { marker: "constant-source" },
      ]),
      { site_id: param("001") },
    );
    expect(semiMembershipComparisonDomain(projected, 0).kind).toBe("proven");
    const projectedNull = project(
      valuesRelation({ marker: { affinity: "text", nullable: false } }, [
        { marker: "constant-source" },
      ]),
      { site_id: param(null) },
    );
    expect(semiMembershipComparisonDomain(projectedNull, 0)).toMatchObject({
      kind: "proven",
      domain: { affinity: "unknown", storageClasses: ["null"] },
    });
    const nullSemi = semiJoin(
      source,
      projectedNull as unknown as TestRelation,
      eq(
        valueColumn(source, "site_id"),
        valueColumn(projectedNull as unknown as TestRelation, "site_id"),
      ),
    );
    const nullDefault = compileD1Query(nullSemi);
    expect(nullDefault.sql).toContain("EXISTS");
    expect(nullDefault.sql).not.toContain(" IN (SELECT ");
    expect(
      compileD1QuerySemiMembershipForceSafeForTest(nullSemi).sql,
    ).toContain(" IN (SELECT ");

    const db = new DatabaseSync(":memory:");
    try {
      for (const collation of ["NOCASE", "RTRIM"] as const) {
        const name = `wave97bm_${collation.toLowerCase()}`;
        const table = textCatalog(name, "unknown");
        db.exec(`CREATE TABLE ${name} (
          site_pk INTEGER PRIMARY KEY,
          site_id TEXT COLLATE ${collation},
          visitor_id TEXT COLLATE BINARY
        )`);
        const leftValue = collation === "NOCASE" ? "A" : "tail ";
        const rightValue = collation === "NOCASE" ? "a" : "tail";
        const insert = db.prepare(
          `INSERT INTO ${name}(site_pk, site_id, visitor_id) VALUES (?, ?, ?)`,
        );
        insert.run(1, leftValue, "left");
        insert.run(101, rightValue, "right");

        const leftBase = relation(table);
        const rightBase = relation(table);
        const left = filter(leftBase, lt(integerColumn(leftBase), param(100)));
        const right = filter(
          rightBase,
          gt(integerColumn(rightBase), param(100)),
        );
        const candidate = semiJoin(
          left,
          right,
          eq(valueColumn(left, "site_id"), valueColumn(right, "site_id")),
        );
        const compiled = compileD1Query(candidate);
        const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
        expect(semiMembershipComparisonDomain(left, 1).kind).toBe("proven");
        expect(compiled.sql).toContain("EXISTS");
        expect(compiled.sql).not.toContain(" IN (SELECT ");
        expect(sortedRows(db, compiled)).toEqual(sortedRows(db, fallback));
        expect(sortedRows(db, compiled)).toEqual([
          { site_pk: 1, site_id: leftValue, visitor_id: "left" },
        ]);
      }
    } finally {
      db.close();
    }
  });
});
