import { DatabaseSync } from "node:sqlite";

// @vitest-environment node
import { expect, it } from "vitest";

import { compileD1Query } from "@/lib/db/query/compiler";
import {
  add,
  avg,
  callFunction,
  caseWhen,
  castReal,
  coalesce,
  constant,
  count,
  eq,
  max,
  min,
  param,
  type SqlExpression,
  sum,
} from "@/lib/db/query/expression";
import {
  deriveOwnerAggregateObligation,
  MAXIMUM_OWNER_ROWS,
  MAXIMUM_SUM_MAGNITUDE,
} from "@/lib/db/query/physical/owner-aggregate-obligations";
import type { AggregateNode } from "@/lib/db/query/plan";
import {
  aggregate,
  filter,
  join,
  project,
  scan,
  union,
} from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
const input = () => project(scan(schema.visits), { a: param(1), b: param(2) });
const aggregateNode = (expression: SqlExpression, owner = input()) => {
  const relation = aggregate(owner, {
    groupBy: {},
    aggregates: { value: expression },
  });
  expect(() => compileD1Query(relation)).not.toThrow();
  if (relation.node.kind !== "aggregate")
    throw new Error("Expected real aggregate node");
  return relation.node;
};
it("attaches separate conversion and raw representative obligations to the exact owner multiset", () => {
  const owner = input();
  const n = aggregate(owner, {
    groupBy: { key: owner.columns.a },
    aggregates: {
      total: sum(coalesce(owner.columns.a, param(0))),
      first: min(coalesce(owner.columns.a, owner.columns.b)),
      last: max(owner.columns.b),
    },
  }).node;
  if (n.kind !== "aggregate") throw new Error("Expected aggregate");
  const o = deriveOwnerAggregateObligation(n, owner.node)!;
  expect(o.input.node).toBe(owner.node);
  expect(o.sumIndexes).toEqual([0]);
  expect(o.extremaIndexes).toEqual([0, 1]);
  expect(o.canonicalOutputIndexes).toEqual([2, 3]);
  expect(o.accepted).toHaveLength(3);
  expect(MAXIMUM_OWNER_ROWS * MAXIMUM_SUM_MAGNITUDE).toBeLessThan(
    Number.MAX_SAFE_INTEGER,
  );
});
it("does not inherit an owner bound through filters, joins, projections, or unions", () => {
  const owner = input(),
    right = input();
  const wrappers = [
    filter(owner, eq(owner.columns.a, param(1))),
    project(owner, { a: owner.columns.a, b: owner.columns.b }),
    union(owner, right),
    join(owner, right, eq(owner.columns.a, right.columns.a)),
  ];
  for (const wrapper of wrappers) {
    const col = Object.values(wrapper.columns)[0]!;
    const n = aggregateNode(
      sum(coalesce(col, param(0))),
      wrapper as ReturnType<typeof input>,
    );
    expect(deriveOwnerAggregateObligation(n, owner.node)).toBeUndefined();
  }
});
it("rejects fresh source, layout, and column metadata mismatches", () => {
  const owner = input(),
    n = aggregateNode(sum(coalesce(owner.columns.a, param(0))), owner);
  const mismatches: AggregateNode[] = [
    { ...n, input: { ...n.input, node: { ...owner.node } } },
    { ...n, input: { ...n.input, scope: input().scope } },
    { ...n, input: { ...n.input, fields: n.input.fields.slice(1) } },
    ...["name", "affinity", "nullable"].map((key) => ({
      ...n,
      input: {
        ...n.input,
        fields: n.input.fields.map((f, i) =>
          i
            ? f
            : {
                ...f,
                [key]:
                  key === "name"
                    ? "changed"
                    : key === "affinity"
                      ? "text"
                      : !f.nullable,
              },
        ),
      },
    })),
  ];
  for (const bad of mismatches)
    expect(deriveOwnerAggregateObligation(bad, owner.node)).toBeUndefined();
  const base = owner.columns.a;
  const badColumns: SqlExpression[] = [
    { ...base, scope: input().scope },
    { ...base, index: 999 },
    { ...base, index: 0.5 },
    { ...base, name: "other" },
    { ...base, resultType: { ...base.resultType, affinity: "text" } },
    {
      ...base,
      resultType: { ...base.resultType, nullable: !base.resultType.nullable },
    },
  ];
  for (const column of badColumns) {
    const expression = {
      ...sum(coalesce(owner.columns.a, param(0))),
      expression: {
        ...coalesce(owner.columns.a, param(0)),
        expressions: [column, param(0)] as const,
      },
    };
    expect(
      deriveOwnerAggregateObligation(
        { ...n, aggregates: [{ name: "value", expression }] },
        owner.node,
      ),
    ).toBeUndefined();
  }
});
it("only admits direct raw plus a constructed numeric zero, never arbitrary SUM totality", () => {
  const owner = input(),
    a = owner.columns.a;
  for (const expression of [
    sum(a),
    sum(add(a, param(1))),
    sum(castReal(a)),
    sum(coalesce(a, param(1))),
    sum(coalesce(a, param(0), param(0))),
    sum(coalesce(add(a, param(0)), param(0))),
    avg(a),
    count(),
  ]) {
    expect(
      deriveOwnerAggregateObligation(
        aggregateNode(expression, owner),
        owner.node,
      ),
    ).toBeUndefined();
  }
  const n = aggregateNode(sum(coalesce(a, param(0))), owner);
  const expression = n.aggregates[0]!.expression;
  expect(
    deriveOwnerAggregateObligation(
      {
        ...n,
        aggregates: [
          {
            name: "value",
            expression: { ...expression, distinct: true } as SqlExpression,
          },
        ],
      },
      owner.node,
    ),
  ).toBeUndefined();
  expect(
    deriveOwnerAggregateObligation(
      aggregateNode(sum(coalesce(a, constant(0))), owner),
      owner.node,
    )?.sumIndexes,
  ).toEqual([0]);
});
it("requires direct raw extrema lineage and homogeneous total indicator construction", () => {
  const owner = input(),
    a = owner.columns.a;
  for (const expression of [
    min(add(a, param(0))),
    min(coalesce(a, param(0))),
    max(add(a, param(0))),
  ])
    expect(
      deriveOwnerAggregateObligation(
        aggregateNode(expression, owner),
        owner.node,
      ),
    ).toBeUndefined();
  for (const value of [
    { one: param(1), zero: param(0) },
    { one: constant(1), zero: constant(0) },
  ]) {
    const expression = max(
      caseWhen([{ when: eq(a, param(1)), then: value.one }], value.zero),
    );
    const o = deriveOwnerAggregateObligation(
      aggregateNode(expression, owner),
      owner.node,
    )!;
    expect(o.accepted).toHaveLength(1);
    expect(o.canonicalOutputIndexes).toEqual([]);
  }
  const bad = [
    max(caseWhen([{ when: eq(a, param(1)), then: constant(1) }], param(0))),
    max(caseWhen([{ when: eq(a, param(1)), then: param(2) }], param(0))),
    max(caseWhen([{ when: eq(a, param(1)), then: param(1) }])),
    max(
      caseWhen(
        [{ when: eq(callFunction("abs", a), param(1)), then: param(1) }],
        param(0),
      ),
    ),
  ];
  for (const expression of bad)
    expect(
      deriveOwnerAggregateObligation(
        aggregateNode(expression, owner),
        owner.node,
      ),
    ).toBeUndefined();
});

// SQL conversion contract only; the composed test separately exercises the compiled guard.
const permutations = <T>(values: readonly T[]): T[][] =>
  values.length
    ? values.flatMap((v, i) =>
        permutations(values.filter((_, j) => j !== i)).map((p) => [v, ...p]),
      )
    : [[]];

it("keeps actual SUM value and INTEGER/REAL storage across permutations of every admitted conversion family", () => {
  const db = new DatabaseSync(":memory:");
  const kinds = [
    { name: "integer", sql: "12" },
    { name: "real-integer", sql: "12.0" },
    { name: "numeric-text", sql: "'12'" },
    { name: "decimal-text", sql: "'12.0'" },
    { name: "numeric-prefix", sql: "'12junk'" },
    { name: "invalid-text", sql: "'invalid-duration'" },
    { name: "numeric-blob", sql: "X'3132'" },
    { name: "invalid-blob", sql: "X'7878'" },
    { name: "null", sql: "NULL" },
    { name: "text-underflow", sql: "'1e-999'" },
    { name: "signed-zero", sql: "-0.0" },
    { name: "positive-bound", sql: "9007199254" },
    { name: "negative-bound", sql: "-9007199254" },
  ];

  const result = (parts: readonly { sql: string }[]) => {
    const sql = `WITH input(v) AS (VALUES ${parts.map((p) => `(${p.sql})`).join(",")}) SELECT
      CASE WHEN COUNT(*)<=1000000 AND COALESCE(MAX(CASE WHEN v IS NULL OR
        (CAST(v AS REAL) BETWEEN -9007199254 AND 9007199254 AND CAST(v AS REAL)=CAST(CAST(v AS REAL) AS INTEGER))
        THEN 0 ELSE 1 END),0)=0 THEN 1 ELSE 0 END AS allowed,
      SUM(COALESCE(v,?1)) AS value, typeof(SUM(COALESCE(v,?1))) AS storage,
      SUM(CAST(COALESCE(v,?1) AS REAL)) AS converted
      FROM input`;
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.get(0) as {
      allowed: bigint;
      value: bigint | number | null;
      storage: string;
      converted: number | null;
    };
  };
  try {
    for (const kind of kinds) {
      const family = [
        kind,
        { name: "cancel-negative", sql: "-17" },
        { name: "cancel-positive", sql: "17" },
        { name: "zero", sql: "0" },
      ];
      const rows = permutations(family).map((p) => ({
        order: p.map((k) => k.name),
        ...result(p),
      }));
      expect(
        rows.every((r) => r.allowed === 1n),
        kind.name,
      ).toBe(true);
      for (const r of rows) {
        expect(r.value).toEqual(rows[0].value);
        expect(r.storage).toEqual(rows[0].storage);
        expect(Number(r.value)).toBe(r.converted);
      }
    }
    const allNull = result([{ sql: "NULL" }, { sql: "NULL" }]);
    expect(allNull).toMatchObject({ allowed: 1n, value: 0, storage: "real" });
    const numericText = result([{ sql: "'12'" }]),
      invalidText = result([{ sql: "'invalid-duration'" }]);
    expect(numericText.storage).toBe("integer");
    expect(invalidText.storage).toBe("real");
    for (const sql of [
      "1.5",
      "'1.5'",
      "X'312E35'",
      "9007199255",
      "9223372036854775807",
      "9e999",
      "'9e999'",
    ]) {
      const row = result([{ sql }]);
      expect(row.allowed, sql).toBe(0n);
    }
  } finally {
    db.close();
  }
});
