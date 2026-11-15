// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  add,
  callFunction,
  castReal,
  constant,
  eq,
  filter,
  gt,
  join,
  project,
  scan,
  union,
} from "@/lib/db";
import { createRelationScope } from "@/lib/db/query/expression";
import {
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import {
  catalogReadExcludesInteger,
  isConditionalGuardExpressionTotal,
  isConditionalGuardNodeTotal,
} from "@/lib/db/query/physical/runtime-guard-totality";
import { schema } from "@/lib/db/schema";

let nextTable = 0;
const registered: string[] = [];
afterEach(() => {
  for (const name of registered.splice(0)) Reflect.deleteProperty(schema, name);
});
function source(
  type = "REAL",
  affinity = "real",
  changes: Record<string, unknown> = {},
) {
  const name = `conditional_abs_proof_${nextTable++}`;
  const column = {
    kind: "column",
    table: name,
    sqlName: "v",
    propertyName: "v",
    declaredType: type,
    affinity,
    nullable: true,
    primaryKeyPosition: 0,
    defaultSql: null,
    hidden: 0,
    generated: false,
    ...changes,
  };
  const table = {
    kind: "table",
    name,
    columns: { v: column },
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
  };
  (schema as unknown as Record<string, unknown>)[name] = table;
  registered.push(name);
  return scan(table as never) as any;
}
const absolute = (e: any) => callFunction("abs", e);
const proven = (s: any) =>
  isConditionalGuardExpressionTotal(absolute(s.columns.v), [s]);

describe("conditional ABS totality uses catalog read storage, not numeric output affinity", () => {
  it("preserves actual REAL reads for historical storage values and original ABS SQL", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE r(v REAL); INSERT INTO r VALUES(-9223372036854775808),(9223372036854775807),(1.25),('-9223372036854775808'),('invalid'),(x'80'),(NULL)",
      );
      const rows = db
        .prepare(
          "SELECT typeof(v) AS storage,abs(v) AS absolute FROM r ORDER BY rowid",
        )
        .all();
      expect(rows.map((r) => r.storage)).toEqual([
        "real",
        "real",
        "real",
        "real",
        "text",
        "blob",
        "null",
      ]);
      expect(rows.map((r) => r.absolute)).toEqual([
        9223372036854776000,
        9223372036854776000,
        1.25,
        9223372036854776000,
        0,
        0,
        null,
      ]);
      const s = source();
      const abs = absolute(s.columns.v);
      expect(proven(s)).toBe(true);
      expect(abs).toMatchObject({
        kind: "function",
        name: "abs",
        arguments: [s.columns.v],
      });
      expect(
        isMaterializationSafeExpression(
          abs,
          new Map([[s.scope, s.fields.length]]),
        ),
      ).toBe(false);
      const selected = filter(s, gt(abs, constant(0)));
      expect(isConditionalGuardNodeTotal(selected.node)).toBe(true);
      expect(isMaterializationSafeNode(selected.node)).toBe(false);
    } finally {
      db.close();
    }
  });
  it.each(["INTEGER", "NUMERIC", "FLOATING POINT"])(
    "retains original INT64_MIN ABS overflow for %s",
    (type) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          `CREATE TABLE r(v ${type}); INSERT INTO r VALUES(-9223372036854775808)`,
        );
        expect(() => db.prepare("SELECT abs(v) FROM r").all()).toThrow(
          /integer overflow/,
        );
        expect(
          proven(
            source(
              type,
              type === "NUMERIC"
                ? "numeric"
                : type === "FLOATING POINT"
                  ? "real"
                  : "integer",
            ),
          ),
        ).toBe(false);
      } finally {
        db.close();
      }
    },
  );
  it("does not admit raw VALUES integer expressions or forged output affinity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        db
          .prepare(
            "WITH v(x) AS (VALUES(-9223372036854775808)) SELECT abs(x) FROM v",
          )
          .all(),
      ).toThrow(/integer overflow/);
    } finally {
      db.close();
    }
    const s = source("INTEGER", "integer");
    expect(
      proven({
        ...s,
        fields: [{ ...s.fields[0], affinity: "real" }],
        columns: {
          v: {
            ...s.columns.v,
            resultType: { affinity: "real", nullable: true },
          },
        },
      }),
    ).toBe(false);
    expect(
      isConditionalGuardExpressionTotal(
        absolute({ ...constant(0), value: -9223372036854776000 }),
        [],
      ),
    ).toBe(false);
  });
  it("follows exact identity projections, NULL union arms, and nullable join padding", () => {
    const s = source();
    const p = project(s, { v: s.columns.v });
    const nil = project(source(), { v: constant(null) });
    expect(proven(p)).toBe(true);
    expect(proven(union(p, nil))).toBe(true);
    const right = source();
    const joined = join(s, right, eq(s.columns.v, right.columns.v), "left");
    const output = project(joined, { v: joined.columns.right_v });
    expect(proven(output)).toBe(true);
    expect(proven(union(p, source("INTEGER", "integer")))).toBe(false);
  });
  it.each([
    { table: "other" },
    { propertyName: "other" },
    { sqlName: "other" },
    { nullable: false },
    { generated: true },
    { hidden: 2 },
    { declaredType: "BLOB" },
    { declaredType: "TEXT" },
  ])("rejects incomplete or contradictory catalog identity %j", (change) => {
    const s = source("REAL", "real", change);
    // nullable mismatch is tested explicitly because scan derives its field from metadata.
    expect(
      proven(
        change.nullable === false
          ? { ...s, fields: [{ ...s.fields[0], nullable: true }] }
          : s,
      ),
    ).toBe(false);
  });
  it("requires complete scope, field, index, and source-node alignment", () => {
    const s = source();
    expect(proven(s)).toBe(true);
    expect(
      proven({ ...s, node: { ...s.node, table: { ...s.node.table } } }),
    ).toBe(false);
    for (const changed of [
      { ...s.columns.v, scope: createRelationScope() },
      { ...s.columns.v, index: 1 },
      { ...s.columns.v, index: 0.5 },
      { ...s.columns.v, name: "other" },
      { ...s.columns.v, resultType: { affinity: "real", nullable: false } },
    ])
      expect(isConditionalGuardExpressionTotal(absolute(changed), [s])).toBe(
        false,
      );
    expect(
      catalogReadExcludesInteger({ ...s, scope: createRelationScope() }, 0),
    ).toBe(false);
    expect(
      catalogReadExcludesInteger(
        { ...s, fields: [{ ...s.fields[0], name: "other" }] },
        0,
      ),
    ).toBe(false);
    expect(
      proven({
        ...s,
        node: { ...s.node, table: { ...s.node.table, kind: "view" } },
      }),
    ).toBe(false);
  });
  it("does not inherit storage proof through computed arithmetic or casts", () => {
    const s = source();
    expect(proven(project(s, { v: add(s.columns.v, constant(0)) }))).toBe(
      false,
    );
    expect(proven(project(s, { v: castReal(s.columns.v) }))).toBe(false);
    expect(
      isConditionalGuardExpressionTotal(absolute(castReal(s.columns.v)), [s]),
    ).toBe(false);
    const unsafe = callFunction("abs", {
      ...constant(0),
      value: -9223372036854776000,
    });
    expect(
      isConditionalGuardExpressionTotal(add(absolute(s.columns.v), unsafe), [
        s,
      ]),
    ).toBe(false);
  });
  it("reproves mutable catalog metadata and handles shared and cyclic lineage conservatively", () => {
    const s = source();
    expect(proven(union(s, s))).toBe(true);
    expect(proven(s)).toBe(true);
    s.node.table.columns.v.declaredType = "INTEGER";
    expect(proven(s)).toBe(false);
    s.node.table.columns.v.declaredType = "REAL";
    expect(proven(s)).toBe(true);
    const p = project(s, { v: s.columns.v }) as any;
    p.node.input = { ...p, node: p.node };
    p.node.projections[0].expression = p.columns.v;
    expect(catalogReadExcludesInteger(p, 0)).toBe(false);
  });
});
