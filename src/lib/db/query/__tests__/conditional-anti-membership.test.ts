// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { expect, it } from "vitest";

import {
  compileD1QuerySemiMembershipFallbackForTest,
  compileD1QuerySemiMembershipForceSafeForTest,
} from "@/lib/db/query/compiler";
import type {
  AnyExpression,
  ColumnExpression,
  ExpressionResultType,
} from "@/lib/db/query/expression";
import { and, eq } from "@/lib/db/query/expression";
import { analyzeSemiMembershipKeyCondition } from "@/lib/db/query/physical/semi-membership";
import { antiJoin, type Relation, scan } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaTableReference } from "@/lib/db/schema/types";

const catalog = (name: string, collation: "BINARY" | "unknown" = "BINARY") =>
  ({
    kind: "table",
    name,
    defaultCollation: collation,
    columns: {
      id: {
        kind: "column",
        table: name,
        sqlName: "id",
        propertyName: "id",
        declaredType: "INTEGER",
        affinity: "integer",
        nullable: false,
        rowidAlias: true,
        primaryKeyPosition: 1,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
      k: {
        kind: "column",
        table: name,
        sqlName: "k",
        propertyName: "k",
        declaredType: "TEXT",
        affinity: "text",
        nullable: true,
        primaryKeyPosition: 0,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
      k2: {
        kind: "column",
        table: name,
        sqlName: "k2",
        propertyName: "k2",
        declaredType: "TEXT",
        affinity: "text",
        nullable: true,
        primaryKeyPosition: 0,
        defaultSql: null,
        hidden: 0,
        generated: false,
      },
    },
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  }) as const satisfies SchemaTableReference;
type RowRelation = Relation<
  Record<string, unknown>,
  Readonly<Record<string, AnyExpression>>
>;
const registered: string[] = [];
function source(table: SchemaTableReference): RowRelation {
  Reflect.set(schema, table.name, table);
  registered.push(table.name);
  return scan(
    table as unknown as typeof schema.site_identities,
  ) as unknown as RowRelation;
}
function col(r: RowRelation, name: string) {
  return r.columns[name] as ColumnExpression<
    string | null,
    ExpressionResultType<"text", true>
  >;
}
function rows(
  db: DatabaseSync,
  q: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(q.sql)
    .all(...((q.bindings ?? []) as SQLInputValue[]))
    .sort((a, b) => Number(a.id) - Number(b.id));
}
it("proves exact typed anti tuple NULL/TEXT/BLOB/duplicate behavior with IS NOT TRUE, and rejects unknown collations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const l = source(catalog("anti_l")),
      r = source(catalog("anti_r"));
    db.exec(
      "CREATE TABLE anti_l(id INTEGER PRIMARY KEY,k TEXT,k2 TEXT);CREATE TABLE anti_r(id INTEGER PRIMARY KEY,k TEXT,k2 TEXT)",
    );
    const vals: SQLInputValue[] = [
      null,
      "",
      "A",
      "a",
      "1",
      "01",
      new Uint8Array([65]),
      new Uint8Array([]),
      1,
      1.5,
    ];
    let id = 0;
    for (const a of vals)
      for (const b of vals)
        db.prepare("INSERT INTO anti_l VALUES(?,?,?)").run(++id, a, b);
    let rightId = 0;
    for (const [a, b] of [
      [null, null],
      ["A", null],
      [null, "A"],
      ["a", "1"],
      [new Uint8Array([65]), ""],
      ["1", 1],
      ["a", "1"],
    ] as SQLInputValue[][])
      db.prepare("INSERT INTO anti_r VALUES(?,?,?)").run(++rightId, a!, b!);
    const details = [];
    for (const tuple of [false, true]) {
      const relation = antiJoin(
        l,
        r,
        tuple
          ? and(eq(col(l, "k"), col(r, "k")), eq(col(l, "k2"), col(r, "k2")))
          : eq(col(l, "k"), col(r, "k")),
      );
      if (relation.node.kind !== "anti-join") throw new Error("expected anti");
      expect(analyzeSemiMembershipKeyCondition(relation.node).kind).toBe(
        "proven",
      );
      const ordinary = compileD1QuerySemiMembershipFallbackForTest(relation),
        candidate = compileD1QuerySemiMembershipForceSafeForTest(relation);
      expect(ordinary.sql).toContain("NOT EXISTS");
      expect(candidate.sql).toContain("IS NOT TRUE");
      expect(candidate.sql).not.toContain("NOT EXISTS");
      const oldRows = rows(db, ordinary),
        newRows = rows(db, candidate);
      expect(newRows).toEqual(oldRows);
      expect(newRows.length).toBeGreaterThan(0);
      const wrong = rows(db, {
        sql: candidate.sql.replace(") IS NOT TRUE", ") IS FALSE"),
        bindings: candidate.bindings,
      });
      expect(wrong).not.toEqual(oldRows);
      details.push({
        tuple,
        ordinary,
        candidate,
        rows: oldRows,
        naiveFalseRows: wrong,
      });
    }
    const bad = source(catalog("anti_nocase", "unknown"));
    const invalid = antiJoin(l, bad, eq(col(l, "k"), col(bad, "k")));
    if (invalid.node.kind !== "anti-join") throw new Error("expected anti");
    expect(analyzeSemiMembershipKeyCondition(invalid.node).kind).toBe(
      "rejected",
    );
    expect(compileD1QuerySemiMembershipForceSafeForTest(invalid).sql).toContain(
      "NOT EXISTS",
    );
  } finally {
    db.close();
    for (const name of registered) Reflect.deleteProperty(schema, name);
  }
});
