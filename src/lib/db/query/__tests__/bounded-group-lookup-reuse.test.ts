import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  callFunction,
  coalesce,
  compileD1Query,
  count,
  eq,
  filter,
  gt,
  join,
  limit,
  neq,
  param,
  project,
  sort,
  sum,
  union,
  valuesRelation,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type LogicalColumnMap = Readonly<Record<string, AnyExpression>>;

interface LookupOptions {
  readonly layout?: "a-b" | "b-a";
  readonly rightShape?: "direct" | "filter" | "project";
  readonly joinType?: "inner" | "left";
  readonly partialKey?: boolean;
  readonly singleUse?: boolean;
  readonly sameParentFanout?: boolean;
  readonly unsafeAggregate?: boolean;
  readonly selectionBarrier?: boolean;
  readonly wrongSource?: boolean;
  readonly nullableKey?: boolean;
}

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = new DatabaseSync(":memory:");
  databases.add(result);
  return result;
}

function columns(relation: AnyRelation): LogicalColumnMap {
  return relation.columns as LogicalColumnMap;
}

function boundedInput(
  selectionBarrier = false,
  nullableKey = true,
): AnyRelation {
  const activityRows = [
    { keyA: "a", keyB: "x", token: "keep-a" },
    { keyA: "a", keyB: "y", token: "keep-b" },
    ...(nullableKey
      ? [
          {
            keyA: null,
            keyB: "z",
            token: "keep-null",
          },
        ]
      : []),
  ];
  const activities = valuesRelation(
    {
      keyA: { affinity: "text", nullable: nullableKey },
      keyB: { affinity: "text", nullable: false },
      token: { affinity: "text", nullable: false },
    },
    activityRows,
  ) as AnyRelation;
  const flags = valuesRelation(
    {
      enabled: { affinity: "text", nullable: false },
    },
    [{ enabled: "yes" }],
  ) as AnyRelation;
  const joined = join(
    activities,
    flags,
    eq(param("one"), param("one") as never),
  ) as AnyRelation;
  const joinedColumns = columns(joined);
  const eligible = filter(
    joined,
    eq(joinedColumns.right_enabled!, param("yes") as never),
  ) as AnyRelation;
  const ordered = selectionBarrier
    ? (sort(eligible, [
        { expression: columns(eligible).left_token!, direction: "ASC" },
      ]) as AnyRelation)
    : eligible;
  return limit(ordered, 32) as AnyRelation;
}

function buildLookupQuery(options: LookupOptions = {}): {
  readonly summary: AnyRelation;
  readonly output: AnyRelation;
} {
  const input = boundedInput(
    options.selectionBarrier,
    options.nullableKey ?? true,
  );
  const keys: Readonly<Record<string, AnyExpression>> = {
    keyA: columns(input).left_keyA!,
    keyB: columns(input).left_keyB!,
  };
  const orderedKeyNames =
    options.layout === "b-a"
      ? (["keyB", "keyA"] as const)
      : (["keyA", "keyB"] as const);
  const summary = aggregate(input, {
    groupBy: Object.fromEntries(
      orderedKeyNames.map((name) => [`group_${name}`, keys[name]!]),
    ),
    aggregates: {
      rowCount: count(),
      ...(options.unsafeAggregate
        ? {
            unsafeAmount: sum(
              callFunction(
                "abs",
                callFunction(
                  "length",
                  columns(input).left_token as SqlExpression<string | null>,
                ),
              ) as SqlExpression<number>,
            ),
          }
        : {}),
    },
  }) as AnyRelation;

  let candidateInput = input;
  if (options.wrongSource)
    candidateInput = boundedInput(
      false,
      options.nullableKey ?? true,
    ) as AnyRelation;
  const candidates = filter(
    candidateInput,
    neq(columns(candidateInput).left_token!, param("exclude") as never),
  ) as AnyRelation;
  const candidateRows =
    options.layout === "b-a"
      ? (project(candidates, {
          candidateToken: columns(candidates).left_token!,
          candidateB: columns(candidates).left_keyB!,
          candidateA: columns(candidates).left_keyA!,
        }) as AnyRelation)
      : candidates;

  let summaryLookup = summary;
  if (options.rightShape === "filter") {
    summaryLookup = filter(
      summary,
      gt(columns(summary).rowCount!, param(0) as never),
    ) as AnyRelation;
  } else if (options.rightShape === "project") {
    summaryLookup = project(summary, {
      lookupA: columns(summary).group_keyA!,
      lookupCount: columns(summary).rowCount!,
      lookupB: columns(summary).group_keyB!,
    }) as AnyRelation;
  }

  const leftColumns = columns(candidateRows);
  const rightColumns = columns(summaryLookup);
  const keyPairs =
    options.layout === "b-a"
      ? ([
          [leftColumns.candidateA!, rightColumns.lookupA!],
          [leftColumns.candidateB!, rightColumns.lookupB!],
        ] as const)
      : ([
          [leftColumns.left_keyA!, rightColumns.group_keyA!],
          [leftColumns.left_keyB!, rightColumns.group_keyB!],
        ] as const);
  const conditionPairs = options.partialKey ? keyPairs.slice(0, 1) : keyPairs;
  const condition = conditionPairs
    .map(([left, right]) => eq(left, right as never))
    .reduce((first, next) => and(first, next));
  const lookup = join(
    candidateRows,
    summaryLookup,
    condition,
    options.joinType ?? "left",
  ) as AnyRelation;
  const lookupColumns = columns(lookup);
  const shared = project(lookup, {
    token:
      options.layout === "b-a"
        ? lookupColumns.left_candidateToken!
        : lookupColumns.left_left_token!,
    rowCount: coalesce(
      options.layout === "b-a"
        ? lookupColumns.right_lookupCount!
        : lookupColumns.right_rowCount!,
      param(0) as never,
    ),
  }) as AnyRelation;
  const sharedColumns = columns(shared);
  const branchA = filter(
    shared,
    eq(sharedColumns.token!, param("keep-a") as never),
  ) as AnyRelation;
  const branchB = filter(
    shared,
    eq(sharedColumns.token!, param("keep-b") as never),
  ) as AnyRelation;
  let output = union(branchA, branchB, true) as AnyRelation;
  if ((options.nullableKey ?? true) && !options.sameParentFanout) {
    const branchNull = filter(
      shared,
      eq(sharedColumns.token!, param("keep-null") as never),
    ) as AnyRelation;
    output = union(output, branchNull, true) as AnyRelation;
  }

  if (options.sameParentFanout) {
    output = union(shared, shared, true) as AnyRelation;
  } else if (options.singleUse) {
    output = branchA;
  }

  return { summary, output };
}

function execute(
  database: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function assertSqliteEquivalent(output: AnyRelation): {
  readonly physical: ReturnType<typeof lowerLogicalPlan>;
  readonly optimized: ReturnType<typeof compileD1Query>;
  readonly optimizedRows: Record<string, unknown>[];
} {
  const physical = lowerLogicalPlan(output);
  const optimized = compileD1Query(physical);
  const unoptimized = compileD1QueryUnoptimizedForTest(output);
  const db = database();
  const optimizedRows = execute(db, optimized);
  expect(rowBag(optimizedRows)).toEqual(rowBag(execute(db, unoptimized)));
  return { physical, optimized, optimizedRows };
}

describe("bounded grouped lookup reuse", () => {
  it("materializes a full-key LEFT lookup through a safe summary filter", () => {
    const { summary, output } = buildLookupQuery({
      rightShape: "filter",
      joinType: "left",
      nullableKey: true,
    });
    const { physical, optimized, optimizedRows } =
      assertSqliteEquivalent(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === summary.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(
      optimizedRows.find(({ token }) => token === "keep-null"),
    ).toMatchObject({ rowCount: 0 });
  });

  it("materializes a reordered aliased full-key INNER lookup", () => {
    const { summary, output } = buildLookupQuery({
      layout: "b-a",
      rightShape: "project",
      joinType: "inner",
      nullableKey: false,
    });
    const { physical } = assertSqliteEquivalent(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === summary.node),
    ).toMatchObject({ materialization: "materialized" });
  });

  it.each([
    ["partial group key", { partialKey: true }],
    ["a single lookup use", { singleUse: true }],
    ["two edges to the same parent", { sameParentFanout: true }],
    ["an unsafe aggregate expression", { unsafeAggregate: true }],
    ["a selection ordering barrier", { selectionBarrier: true }],
    ["a candidate from another bounded input", { wrongSource: true }],
  ] as const)("does not license %s", (_label, options) => {
    const { summary, output } = buildLookupQuery(options);
    const { physical } = assertSqliteEquivalent(output);
    expect(
      physical.sharedRelations.some(({ node }) => node === summary.node),
    ).toBe(false);
  });

  it("keeps NULL groups and LEFT-join defaults without changing the row bag", () => {
    const { summary, output } = buildLookupQuery({
      joinType: "left",
    });
    const { physical, optimized, optimizedRows } =
      assertSqliteEquivalent(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === summary.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(
      optimizedRows.find(({ token }) => token === "keep-null"),
    ).toMatchObject({ rowCount: 0 });
  });
});
