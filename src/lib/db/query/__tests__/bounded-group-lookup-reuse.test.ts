import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  callFunction,
  caseWhen,
  coalesce,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  join,
  limit,
  lte,
  neq,
  param,
  project,
  scan,
  sort,
  sum,
  union,
  valuesRelation,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

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
  readonly admissionGate?: boolean;
  readonly admissionInputProjection?: boolean;
  readonly unitBoundedSum?: boolean;
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

function boundedScanInput(): AnyRelation {
  const visits = scan(schema.visits);
  const scopedVisits = filter(
    visits,
    eq(visits.columns.site_id, constant("admission-a")),
  );
  const siteIdentities = scan(schema.site_identities);
  const joined = join(
    scopedVisits,
    siteIdentities,
    eq(scopedVisits.columns.site_pk, siteIdentities.columns.site_pk),
  ) as AnyRelation;
  const eligible = filter(
    joined,
    eq(columns(joined).right_site_id!, constant("admission-a") as never),
  ) as AnyRelation;
  const shaped = project(eligible, {
    left_keyA: columns(eligible).left_site_id!,
    left_keyB: columns(eligible).left_visit_id!,
    left_token: columns(eligible).left_pathname!,
  }) as AnyRelation;
  return limit(shaped, 32) as AnyRelation;
}

function admissionDatabase(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  const insertSite = result.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  insertSite.run("admission-a");
  const sitePk = Number(
    (
      result
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("admission-a") as { readonly site_pk: number }
    ).site_pk,
  );
  const insertVisit = result.prepare(
    `INSERT INTO visits (
       visit_id, site_id, visitor_id, session_id, status, started_at,
       last_activity_at, duration_source, pathname, hostname, site_pk
     ) VALUES (?, 'admission-a', ?, ?, 'complete', ?, ?, 'timer', ?, 'example.test', ?)`,
  );
  for (const [index, token] of ["keep-a", "keep-b", "keep-null"].entries())
    insertVisit.run(
      `admission-visit-${index}`,
      `admission-visitor-${index}`,
      `admission-session-${index}`,
      index + 1,
      index + 1,
      token,
      sitePk,
    );
  return result;
}

function buildLookupQuery(options: LookupOptions = {}): {
  readonly summary: AnyRelation;
  readonly output: AnyRelation;
  readonly bounded?: AnyRelation;
  readonly counter?: AnyRelation;
  readonly admittedRows?: AnyRelation;
} {
  const bounded = options.admissionGate
    ? boundedScanInput()
    : boundedInput(options.selectionBarrier, options.nullableKey ?? true);
  let input = bounded;
  let counter: AnyRelation | undefined;
  let admittedRows: AnyRelation | undefined;
  let countControl: AnyRelation | undefined;
  if (options.admissionGate) {
    counter = aggregate(bounded, {
      groupBy: {},
      aggregates: { rowCount: count() },
    }) as AnyRelation;
    const admittedCounter = filter(
      counter,
      // Numeric parameters are also accepted by the event builder's count
      // threshold proof; this generic fixture uses its integer literal form.
      lte(counter.columns.rowCount!, constant(31) as never),
    ) as AnyRelation;
    const truePredicate = eq(constant(1), constant(1));
    const boundedRowsJoin = join(
      bounded,
      admittedCounter,
      truePredicate,
    ) as AnyRelation;
    admittedRows = project(boundedRowsJoin, {
      left_keyA: columns(boundedRowsJoin).left_left_keyA!,
      left_keyB: columns(boundedRowsJoin).left_left_keyB!,
      left_token: columns(boundedRowsJoin).left_left_token!,
    }) as AnyRelation;
    input = admittedRows;
    if (options.admissionInputProjection) {
      input = project(input, {
        left_keyA: columns(input).left_keyA!,
        left_keyB: columns(input).left_keyB!,
        left_token: columns(input).left_token!,
      }) as AnyRelation;
    }
    countControl = project(counter, {
      rowCount: counter.columns.rowCount!,
    }) as AnyRelation;
  }
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
      rowCount: options.unitBoundedSum
        ? sum(
            caseWhen(
              [
                {
                  when: eq(
                    columns(input).left_token!,
                    param("keep-a") as never,
                  ),
                  then: constant(1),
                },
              ],
              constant(0),
            ) as SqlExpression<number>,
          )
        : count(),
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

  if (countControl) {
    output = union(
      output,
      project(countControl, {
        token: constant("count"),
        rowCount: columns(countControl).rowCount!,
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  return {
    summary,
    output,
    ...(options.admissionGate ? { bounded, counter, admittedRows: input } : {}),
  };
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

function assertSqliteEquivalent(
  output: AnyRelation,
  db: DatabaseSync = database(),
): {
  readonly physical: ReturnType<typeof lowerLogicalPlan>;
  readonly optimized: ReturnType<typeof compileD1Query>;
  readonly optimizedRows: Record<string, unknown>[];
} {
  const physical = lowerLogicalPlan(output);
  const optimized = compileD1Query(physical);
  const unoptimized = compileD1QueryUnoptimizedForTest(output);
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

  it("rechecks a grouped summary through one fresh bounded admission join", () => {
    const built = buildLookupQuery({ admissionGate: true });
    const { physical, optimized } = assertSqliteEquivalent(
      built.output,
      admissionDatabase(),
    );
    expect(built.bounded).toBeDefined();
    expect(built.counter).toBeDefined();
    expect(
      physical.sharedRelations.find(({ node }) => node === built.bounded?.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      physical.sharedRelations.find(({ node }) => node === built.counter?.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      physical.sharedRelations.find(({ node }) => node === built.summary.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(optimized.sql).toContain("AS MATERIALIZED (");
  });

  it("proves a unit-bounded SUM through an exact admitted-row projection", () => {
    const built = buildLookupQuery({
      admissionGate: true,
      admissionInputProjection: true,
      unitBoundedSum: true,
    });
    const { physical, optimized } = assertSqliteEquivalent(
      built.output,
      admissionDatabase(),
    );
    expect(
      physical.sharedRelations.find(({ node }) => node === built.summary.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(optimized.sql).toContain("AS MATERIALIZED (");
  });
});
