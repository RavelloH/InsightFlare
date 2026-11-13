import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  join,
  limit,
  or,
  param,
  project,
  semiJoin,
  sort,
  union,
  unixepoch,
  valuesRelation,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, Predicate } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type Cols = Readonly<Record<string, AnyExpression>>;

const databases = new Set<DatabaseSync>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

const cols = (relation: AnyRelation): Cols => relation.columns as Cols;

function boundedInput(nullableKey: boolean): AnyRelation {
  const activities = valuesRelation(
    {
      keyA: { affinity: "text", nullable: nullableKey },
      keyB: { affinity: "text", nullable: false },
      token: { affinity: "text", nullable: false },
    },
    [
      { keyA: "a", keyB: "x", token: "keep-a" },
      { keyA: "a", keyB: "y", token: "keep-b" },
      ...(nullableKey ? [{ keyA: null, keyB: "z", token: "keep-n" }] : []),
    ],
  ) as AnyRelation;
  const flags = valuesRelation(
    { enabled: { affinity: "text", nullable: false } },
    [{ enabled: "yes" }],
  ) as AnyRelation;
  const joined = join(
    activities,
    flags,
    eq(param("one"), param("one") as never),
  ) as AnyRelation;
  const eligible = filter(
    joined,
    eq(cols(joined).right_enabled!, param("yes") as never),
  ) as AnyRelation;
  return limit(eligible, 32) as AnyRelation;
}

interface Options {
  readonly nullableKey?: boolean;
  readonly joinType?: "inner" | "left";
  readonly rightFilter?: boolean;
  readonly condition?: (bounded: Cols, lookup: Cols) => Predicate;
}

function build(options: Options = {}): {
  readonly summary: AnyRelation;
  readonly output: AnyRelation;
} {
  const bounded = boundedInput(options.nullableKey ?? false);
  const b = cols(bounded);
  const summary = aggregate(bounded, {
    groupBy: { groupA: b.left_keyA!, groupB: b.left_keyB! },
    aggregates: { rowCount: count() },
  }) as AnyRelation;
  const s = cols(summary);
  let lookupSource = project(summary, {
    lookupA: s.groupA!,
    lookupB: s.groupB!,
    lookupCount: s.rowCount!,
  }) as AnyRelation;
  if (options.rightFilter)
    lookupSource = filter(
      lookupSource,
      gt(cols(lookupSource).lookupCount as never, param(0) as never),
    ) as AnyRelation;
  const l = cols(lookupSource);
  const condition =
    options.condition?.(b, l) ??
    and(
      eq(b.left_keyA!, l.lookupA as never),
      eq(b.left_keyB!, l.lookupB as never),
    );
  const lookup = join(
    bounded,
    lookupSource,
    condition,
    options.joinType ?? "left",
  ) as AnyRelation;
  const lc = cols(lookup);
  const reportRows = valuesRelation(
    {
      keyA: { affinity: "text", nullable: false },
      keyB: { affinity: "text", nullable: false },
      token: { affinity: "text", nullable: false },
    },
    [
      { keyA: "a", keyB: "x", token: "semi-hit-x" },
      { keyA: "b", keyB: "z", token: "anti-miss" },
    ],
  ) as AnyRelation;
  const r = cols(reportRows);
  const membership = and(
    eq(r.keyA!, lc.left_left_keyA! as never),
    eq(r.keyB!, lc.left_left_keyB! as never),
  );
  const mark = (relation: AnyRelation, branch: string) =>
    project(relation, {
      branch: constant(branch),
      keyA: cols(relation).keyA!,
      keyB: cols(relation).keyB!,
      token: cols(relation).token!,
    }) as AnyRelation;
  const merged = union(
    mark(semiJoin(reportRows, lookup, membership) as AnyRelation, "semi"),
    mark(antiJoin(reportRows, lookup, membership) as AnyRelation, "anti"),
    true,
  ) as AnyRelation;
  const m = cols(merged);
  const ordered = sort(merged, [
    { expression: m.token!, direction: "ASC" },
    { expression: m.branch!, direction: "ASC" },
  ]) as AnyRelation;
  return { summary, output: limit(ordered, 20) as AnyRelation };
}

function run(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function isMaterialized(options: Options): boolean {
  const { summary, output } = build(options);
  const physical = lowerLogicalPlan(output);
  const db = createMigratedDatabase();
  databases.add(db);
  const bag = (rows: Record<string, unknown>[]) =>
    rows.map((row) => JSON.stringify(row)).sort();
  expect(bag(run(db, compileD1Query(physical)))).toEqual(
    bag(run(db, compileD1QueryUnoptimizedForTest(output))),
  );
  return (
    physical.sharedRelations.find(({ node }) => node === summary.node)
      ?.materialization === "materialized"
  );
}

describe("bounded group summary lookup join gaps", () => {
  it("accepts the exact full-key lookup baseline", () => {
    expect(isMaterialized({})).toBe(true);
    expect(isMaterialized({ joinType: "left", rightFilter: true })).toBe(true);
  });

  it("rejects an INNER lookup over a filtered summary or a nullable key", () => {
    expect(isMaterialized({ joinType: "inner", rightFilter: true })).toBe(
      false,
    );
    expect(isMaterialized({ joinType: "inner", nullableKey: true })).toBe(
      false,
    );
  });

  it("rejects conditions that are not exactly one direct equality per group key", () => {
    const cases: readonly ((b: Cols, l: Cols) => Predicate)[] = [
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupA as never),
          eq(unixepoch() as AnyExpression, param(0) as never),
        ),
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupA as never),
          gt(b.left_keyB! as never, l.lookupB as never),
        ),
      (b, l) =>
        or(
          eq(b.left_keyA!, l.lookupA as never),
          eq(b.left_keyB!, l.lookupB as never),
        ),
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupA as never),
          eq(callFunction("lower", b.left_keyB as never), l.lookupB as never),
        ),
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupA as never),
          eq(b.left_keyB!, b.left_token as never),
        ),
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupA as never),
          eq(b.left_keyA!, l.lookupA as never),
        ),
      (b, l) =>
        and(
          eq(b.left_keyA!, l.lookupB as never),
          eq(b.left_keyB!, l.lookupA as never),
        ),
    ];
    for (const condition of cases)
      expect(isMaterialized({ condition })).toBe(false);
  });
});
