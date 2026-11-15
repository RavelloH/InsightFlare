// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { Predicate, SqlExpression } from "@/lib/db";
import {
  add,
  aggregate,
  and,
  antiJoin,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  castText,
  coalesce,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  gt,
  inList,
  inSubquery,
  isDistinctFrom,
  isNull,
  join,
  limit,
  not,
  or,
  param,
  project,
  rowNumber,
  scan,
  semiJoin,
  sort,
  textLike,
  textPosition,
  textSubstring,
  union,
  unixepoch,
  valuesRelation,
  window,
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
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

const source = () => scan(schema.custom_event_json_values);
const realSource = () => {
  const s = source();
  return project(s, { v: s.columns.number_value });
};
const abs = (e: SqlExpression<number | null>) => callFunction("abs", e);
const partial = () => abs(param(-9223372036854775808));
const read = catalogReadExcludesInteger;

// Each wrapper is built through public typed IR APIs. The proof must look
// through the whole expression; it cannot license unsafe sibling expressions.
const wrappers: readonly {
  name: string;
  wrap: (e: ReturnType<typeof abs>) => SqlExpression;
}[] = [
  { name: "distinct comparison", wrap: (e) => isDistinctFrom(e, constant(0)) },
  {
    name: "AND",
    wrap: (e) => and(gt(e, constant(0)), eq(constant(1), constant(1))),
  },
  {
    name: "OR",
    wrap: (e) => or(gt(e, constant(0)), eq(constant(1), constant(0))),
  },
  { name: "NOT", wrap: (e) => not(gt(e, constant(0))) },
  { name: "NULL test", wrap: (e) => isNull(e) },
  { name: "INTEGER cast", wrap: (e) => castInteger(e) },
  { name: "REAL cast", wrap: (e) => castReal(e) },
  { name: "TEXT cast", wrap: (e) => castText(e) },
  {
    name: "text position",
    wrap: (e) => textPosition(castText(e), constant("1")),
  },
  {
    name: "substring without length",
    wrap: (e) => textSubstring(castText(e), constant(1)),
  },
  {
    name: "substring with length",
    wrap: (e) => textSubstring(castText(e), constant(1), constant(2)),
  },
  { name: "LIKE", wrap: (e) => textLike(castText(e), constant("%")) },
  { name: "IN list", wrap: (e) => inList(e, [1, 2]) },
  { name: "coalesce", wrap: (e) => coalesce(e, constant(0)) },
  {
    name: "nested total function",
    wrap: (e) => callFunction("lower", castText(e)),
  },
  {
    name: "CASE condition",
    wrap: (e) =>
      caseWhen([{ when: gt(e, constant(0)), then: constant(1) }], constant(0)),
  },
  {
    name: "CASE result",
    wrap: (e) =>
      caseWhen(
        [{ when: eq(constant(1), constant(1)), then: e }],
        constant(null),
      ),
  },
  {
    name: "CASE implicit NULL",
    wrap: (e) => caseWhen([{ when: eq(constant(1), constant(1)), then: e }]),
  },
];

function nativeFixture() {
  const db = new DatabaseSync(":memory:");
  const columns = Object.values(schema.custom_event_json_values.columns);
  db.exec(
    `CREATE TABLE custom_event_json_values(${columns.map((c) => `"${c.sqlName}" ${c.declaredType}`).join(",")}); INSERT INTO custom_event_json_values(number_value,boolean_value) VALUES(-9223372036854775808,-9223372036854775808),(1.25,1),('invalid',0),(x'80',NULL),(NULL,NULL)`,
  );
  return db;
}
function executeExpression(
  db: DatabaseSync,
  e: SqlExpression,
  input: ReturnType<typeof source>,
) {
  const q = compileD1Query(project(input, { result: e }));
  const bindings = (q.bindings ?? []).map((v) => {
    if (typeof v === "boolean") return Number(v);
    if (v === null || typeof v === "number" || typeof v === "string") return v;
    throw new Error("This scalar fixture should not bind a non-scalar value");
  });
  const statement = db.prepare(q.sql);
  statement.setReadBigInts(true);
  return statement.all(...bindings);
}

describe("conditional ABS totality preserves nested observers and error siblings", () => {
  it.each(wrappers)(
    "reproves $name using original REAL-read SQL and rejects INTEGER overflow",
    ({ wrap }) => {
      const s = source();
      const expression = wrap(abs(s.columns.number_value));
      const unsafe = wrap(abs(s.columns.boolean_value));
      expect(
        isMaterializationSafeExpression(
          expression,
          new Map([[s.scope, s.fields.length]]),
        ),
      ).toBe(false);
      expect(isConditionalGuardExpressionTotal(expression, [s])).toBe(true);
      expect(isConditionalGuardExpressionTotal(unsafe, [s])).toBe(false);
      const db = nativeFixture();
      try {
        // The certifier must not replace execution with its analysis-only zero.
        const before = executeExpression(db, expression, s);
        expect(before).toHaveLength(5);
        expect(() => executeExpression(db, unsafe, s)).toThrow(
          /integer overflow/,
        );
        expect(executeExpression(db, expression, s)).toEqual(before);
      } finally {
        db.close();
      }
    },
  );
  it("does not let one licensed ABS hide a partial sibling in any expression slot", () => {
    const s = source(),
      safe = abs(s.columns.number_value),
      bad = partial();
    const expressions: SqlExpression[] = [
      add(safe, bad),
      isDistinctFrom(bad, safe),
      and(gt(safe, constant(0)), gt(bad, constant(0))),
      coalesce(safe, bad),
      textPosition(castText(safe), castText(bad)),
      textPosition(castText(bad), castText(safe)),
      textSubstring(castText(safe), bad),
      textSubstring(castText(safe), constant(1), bad),
      textSubstring(castText(bad), constant(1), constant(2)),
      textLike(castText(safe), castText(bad)),
      textLike(castText(bad), castText(safe)),
      inList(bad, [1]),
      caseWhen([{ when: gt(safe, constant(0)), then: bad }], constant(null)),
      caseWhen([{ when: gt(bad, constant(0)), then: safe }], constant(null)),
      caseWhen([{ when: gt(safe, constant(0)), then: safe }], bad),
      callFunction("round", bad),
    ];
    for (const e of expressions)
      expect(isConditionalGuardExpressionTotal(e, [s])).toBe(false);
  });
  it("reruns the ordinary checker after substitution, preserving invalid bindings and volatile/subquery rejection", () => {
    const s = source(),
      safe = abs(s.columns.number_value);
    const child = project(source(), { v: constant(1) });
    const expressions: SqlExpression[] = [
      inList(safe, [NaN]),
      add(safe, param(Infinity)),
      add(safe, unixepoch()),
      and(gt(safe, constant(0)), inSubquery(constant(1), child)),
      add(safe, count()),
    ];
    for (const e of expressions)
      expect(isConditionalGuardExpressionTotal(e, [s])).toBe(false);
    expect(
      isConditionalGuardExpressionTotal(add(constant(1), constant(2)), []),
    ).toBe(true);
    // A closed node is not licensed by some unrelated source's REAL field.
    expect(isConditionalGuardExpressionTotal(safe, [source()])).toBe(false);
  });
  it("rejects malformed ABS arity and expression cycles rather than reusing partial proof", () => {
    const s = source(),
      expression = abs(s.columns.number_value);
    expect(
      isConditionalGuardExpressionTotal({ ...expression, arguments: [] }, [s]),
    ).toBe(false);
    expect(
      isConditionalGuardExpressionTotal(
        { ...expression, arguments: [s.columns.number_value, constant(1)] },
        [s],
      ),
    ).toBe(false);
    const cyclic: {
      kind: "not";
      expression: Predicate;
      resultType: { affinity: "integer"; nullable: true };
    } = {
      kind: "not",
      expression: gt(expression, constant(0)),
      resultType: { affinity: "integer", nullable: true },
    };
    cyclic.expression = cyclic;
    expect(isConditionalGuardExpressionTotal(cyclic, [s])).toBe(false);
  });
});

describe("catalog lineage is complete, fresh, and restricted to raw REAL reads", () => {
  it("follows filters/distinct/sort/limit and passthrough window fields but rejects new window outputs", () => {
    const raw = realSource();
    const filtered = filter(raw, gt(raw.columns.v, constant(0)));
    const unique = distinct(filtered);
    const ordered = sort(unique, [
      { expression: unique.columns.v, direction: "ASC" },
    ]);
    const bounded = limit(ordered, 2);
    const ranked = window(bounded, {
      rn: rowNumber({
        orderBy: [{ expression: bounded.columns.v, direction: "ASC" }],
      }),
    });
    for (const s of [raw, filtered, unique, ordered, bounded, ranked])
      expect(read(s, 0)).toBe(true);
    expect(read(ranked, 1)).toBe(false);
    expect(
      isConditionalGuardExpressionTotal(abs(ranked.columns.rn), [ranked]),
    ).toBe(false);
  });
  it("requires both set arms and the correct join/membership side, not a neighboring REAL column", () => {
    const a = realSource(),
      b = realSource();
    const merged = union(a, b, true);
    expect(read(merged, 0)).toBe(true);
    const s = source(),
      integer = project(s, { v: s.columns.boolean_value });
    expect(read(union(a, integer, true), 0)).toBe(false);
    expect(read(union(integer, a), 0)).toBe(false);
    for (const j of [
      join(a, b, eq(a.columns.v, b.columns.v)),
      join(a, b, eq(a.columns.v, b.columns.v), "left"),
    ]) {
      expect(read(j, 0)).toBe(true);
      expect(read(j, 1)).toBe(true);
    }
    const mixed = join(integer, a, eq(integer.columns.v, a.columns.v), "left");
    expect(read(mixed, 0)).toBe(false);
    expect(read(mixed, 1)).toBe(true);
    const on = eq(a.columns.v, integer.columns.v);
    for (const m of [semiJoin(a, integer, on), antiJoin(a, integer, on)])
      expect(read(m, 0)).toBe(true);
    for (const m of [semiJoin(integer, a, on), antiJoin(integer, a, on)])
      expect(read(m, 0)).toBe(false);
    const grouped = aggregate(a, {
      groupBy: { v: a.columns.v },
      aggregates: { n: count() },
    });
    expect(read(grouped, 0)).toBe(false);
    const literalRows = valuesRelation(
      { v: { affinity: "text", nullable: false } },
      [{ v: "1" }],
    );
    expect(read(literalRows, 0)).toBe(false);
  });
  it("freshly rejects invalid indexes, truncated/mismatched fields, and active lineage keys", () => {
    const raw = source();
    const fields = [
      ...raw.fields,
      {
        name: "missing_catalog_column",
        affinity: "real" as const,
        nullable: true,
      },
    ];
    expect(
      read(
        { ...raw, fields, node: { ...raw.node, fields } },
        fields.length - 1,
      ),
    ).toBe(false);
    const s = realSource();
    for (const index of [
      -1,
      NaN,
      Infinity,
      0.5,
      1,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(read(s, index)).toBe(false);
    expect(read({ ...s, fields: [] }, 0)).toBe(false);
    expect(
      read({ ...s, fields: [{ ...s.fields[0]!, nullable: false }] }, 0),
    ).toBe(false);
    expect(read({ ...s, scope: createRelationScope() }, 0)).toBe(false);
    expect(read(s, 0, new Map([[s.node, new Set([0])]]))).toBe(false);
    expect(read(s, 0, new Map([[s.node, new Set([1])]]))).toBe(true);
    if (s.node.kind !== "project")
      throw new Error("typed project fixture lost");
    const rename = {
      ...s.node,
      projections: [{ ...s.node.projections[0]!, name: "other" }],
    };
    expect(read({ ...s, node: rename }, 0)).toBe(false);
    const missing = { ...s.node, projections: [] };
    expect(read({ ...s, node: missing }, 0)).toBe(false);
  });
});

describe("node guards prove every original condition and projection", () => {
  it("rejects unsafe projection siblings, all three join kinds' partial conditions, and unsupported nodes", () => {
    const s = source(),
      other = source(),
      safe = abs(s.columns.number_value),
      bad = abs(s.columns.boolean_value);
    const goodProject = project(s, { safe, ordinary: constant(1) });
    expect(isConditionalGuardNodeTotal(goodProject.node)).toBe(true);
    expect(isConditionalGuardNodeTotal(project(s, { safe, bad }).node)).toBe(
      false,
    );
    const good = gt(safe, other.columns.number_value),
      wrong = gt(bad, other.columns.number_value);
    const nodes: readonly LogicalQueryNode[] = [
      join(s, other, good).node,
      semiJoin(s, other, good).node,
      antiJoin(s, other, good).node,
    ];
    for (const node of nodes) {
      expect(isMaterializationSafeNode(node)).toBe(false);
      expect(isConditionalGuardNodeTotal(node)).toBe(true);
    }
    for (const node of [
      join(s, other, wrong).node,
      semiJoin(s, other, wrong).node,
      antiJoin(s, other, wrong).node,
    ])
      expect(isConditionalGuardNodeTotal(node)).toBe(false);
    expect(
      isConditionalGuardNodeTotal(filter(s, gt(bad, constant(0))).node),
    ).toBe(false);
    const unsafeSort = sort(s, [{ expression: bad, direction: "ASC" }]);
    expect(isConditionalGuardNodeTotal(unsafeSort.node)).toBe(false);
    expect(
      isConditionalGuardNodeTotal(project(s, { v: constant(1) }).node),
    ).toBe(true);
  });
});
