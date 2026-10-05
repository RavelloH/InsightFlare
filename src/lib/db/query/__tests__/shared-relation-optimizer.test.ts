import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  add,
  aggregate,
  and,
  castReal,
  coalesce,
  compileD1Query,
  constant,
  count,
  countDistinct,
  div,
  eq,
  filter,
  gt,
  inSubquery,
  isNotNull,
  join,
  limit,
  lt,
  neq,
  or,
  param,
  project,
  rowNumber,
  scalar,
  scan,
  sort,
  union,
  unixepoch,
  valuesRelation,
  window,
  windowCountRows,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type {
  Relation,
  TextRowRelationRow,
  TextRowRelationSchema,
} from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

const databases = new Set<DatabaseSync>();

function selectedProjection(width: number, selective = true) {
  const identities = scan(schema.site_identities);
  const projected = project(identities, {
    sitePk: identities.columns.site_pk,
    siteId: identities.columns.site_id,
  });
  const filtered = selective
    ? filter(projected, gt(projected.columns.sitePk, param(0)))
    : projected;
  const available = Object.values(filtered.columns) as AnyExpression[];
  const projections: Record<string, AnyExpression> = {};
  for (let index = 0; index < width; index += 1)
    projections[`field${index}`] = available[index % available.length]!;
  return project(filtered, projections);
}

function nullablePageProjection() {
  const pages = scan(schema.visits);
  const selected = filter(pages, eq(pages.columns.status, param("complete")));
  return project(selected, {
    field0: selected.columns.ended_at,
    field1: selected.columns.duration_ms,
    field2: selected.columns.duration_source,
    field3: selected.columns.session_id,
    field4: selected.columns.pathname,
  });
}

function selectedWideTextProjection(width: number, selective = true): Relation {
  const fieldNames = Array.from(
    { length: width },
    (_, index) => `field${index}`,
  );
  const schema = Object.fromEntries([
    ["keep", { affinity: "text", nullable: false }],
    ...fieldNames.map((name) => [name, { affinity: "text", nullable: true }]),
  ]) as TextRowRelationSchema;
  const row = (
    keep: string,
    key: string | null,
    order: string | null,
    payload: string,
  ): TextRowRelationRow<typeof schema> =>
    Object.fromEntries([
      ["keep", keep],
      ...fieldNames.map((name, index) => [
        name,
        index === 0
          ? key
          : index === 1
            ? order
            : index % 3 === 0
              ? null
              : `${payload}-${index}`,
      ]),
    ]) as TextRowRelationRow<typeof schema>;
  const rows = valuesRelation(schema, [
    row("yes", "same", "a", "duplicate"),
    row("yes", "same", "a", "duplicate"),
    row("yes", null, "z", "null-key"),
    row("yes", "other", null, "null-order"),
    row("no", "filtered", "b", "filtered"),
  ]);
  const selected = selective
    ? filter(rows, eq(rows.columns.keep, param("yes")))
    : rows;
  const projections: Record<string, AnyExpression> = {};
  for (const name of fieldNames) projections[name] = selected.columns[name]!;
  return project(selected, projections);
}

function closedConstantExistenceWindowCandidate(
  options: {
    readonly windowInputCorrelation?: "input" | "partition" | "order";
    readonly windowKind?: "row-number" | "count-rows";
    readonly barrier?: "sort" | "limit";
    readonly nestedNonconstantQuery?: boolean;
    readonly queryKind?: "scalar" | "in";
  } = {},
) {
  const pageSchema = {
    sitePk: { affinity: "text", nullable: false },
    sessionId: { affinity: "text", nullable: true },
    startedAt: { affinity: "text", nullable: false },
  } as const;
  const outerPages = valuesRelation(pageSchema, [
    {
      sitePk: "1",
      sessionId: "session-a",
      startedAt: "11",
    },
    {
      sitePk: "1",
      sessionId: "session-a",
      startedAt: "11",
    },
    {
      sitePk: "1",
      sessionId: "missing-session",
      startedAt: "13",
    },
    {
      sitePk: "1",
      sessionId: null,
      startedAt: "14",
    },
  ]);
  const innerPages = valuesRelation(pageSchema, [
    {
      sitePk: "1",
      sessionId: "session-a",
      startedAt: "30",
    },
    {
      sitePk: "1",
      sessionId: "session-a",
      startedAt: "10",
    },
    {
      sitePk: "2",
      sessionId: "session-a",
      startedAt: "1",
    },
  ]);
  const windowInput =
    options.windowInputCorrelation === "input"
      ? filter(
          innerPages,
          eq(innerPages.columns.sitePk, outerPages.columns.sitePk),
        )
      : innerPages;
  const partitionBy = [innerPages.columns.sitePk, innerPages.columns.sessionId];
  if (options.windowInputCorrelation === "partition")
    partitionBy.push(outerPages.columns.sitePk);
  const ranked = window(windowInput, {
    rank:
      options.windowKind === "count-rows"
        ? windowCountRows({ partitionBy })
        : rowNumber({
            partitionBy,
            orderBy: [
              {
                expression:
                  options.windowInputCorrelation === "order"
                    ? outerPages.columns.startedAt
                    : innerPages.columns.startedAt,
                direction: "ASC",
              },
            ],
          }),
  });
  const boundarySource =
    options.barrier === "sort"
      ? sort(ranked, [{ expression: ranked.columns.rank, direction: "ASC" }])
      : options.barrier === "limit"
        ? limit(ranked, 10)
        : ranked;
  const nestedNonconstantSource = project(innerPages, {
    value: innerPages.columns.sitePk,
  });
  const nestedQueryBoundary = options.nestedNonconstantQuery
    ? filter(boundarySource, eq(scalar(nestedNonconstantSource), param("1")))
    : boundarySource;
  const matchingBoundary = filter(
    nestedQueryBoundary,
    and(
      eq(ranked.columns.sitePk, outerPages.columns.sitePk),
      eq(ranked.columns.sessionId, outerPages.columns.sessionId),
      eq(ranked.columns.rank, param(1)),
    ),
  );
  const existence = project(matchingBoundary, { found: constant(1) });
  const selected = filter(
    outerPages,
    options.queryKind === "in"
      ? inSubquery(param(1), existence)
      : eq(scalar(existence), constant(1)),
  );
  const candidate = project(selected, {
    sitePk: selected.columns.sitePk,
    sessionId: selected.columns.sessionId,
    startedAt: selected.columns.startedAt,
  });
  return { candidate, existence, innerPages, outerPages, ranked };
}

function independentWindowUnion(source: Relation, count: number): Relation {
  const branches = Array.from({ length: count }, (_, index) =>
    window(source, {
      rank: rowNumber({
        partitionBy: [source.columns[`field${index % source.fields.length}`]!],
        orderBy: [
          {
            expression:
              source.columns[`field${(index + 1) % source.fields.length}`]!,
            direction: index % 2 === 0 ? "ASC" : "DESC",
          },
        ],
      }),
    }),
  );
  return branches
    .slice(1)
    .reduce((combined, branch) => union(combined, branch, true), branches[0]!);
}

function rowBag(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => JSON.stringify(row)).sort();
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function repeatedThree<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>) {
  return union(union(relation, relation, true), relation, true);
}

function buildAggregateRankingQuery(
  input: {
    readonly limit?: number;
    readonly cursor?: {
      readonly bounceRate: number;
      readonly views: number;
      readonly pathname: string;
    };
    readonly volatile?: boolean;
  } = {},
) {
  const pages = valuesRelation(
    {
      pathname: { affinity: "text", nullable: false },
      sessionId: { affinity: "text", nullable: false },
      visitorId: { affinity: "text", nullable: false },
      durationKey: { affinity: "text", nullable: false },
    },
    [
      { pathname: "/a", sessionId: "s-a", visitorId: "v-a", durationKey: "5" },
      { pathname: "/a", sessionId: "s-a", visitorId: "v-a", durationKey: "5" },
      { pathname: "/a", sessionId: "s-b", visitorId: "v-b", durationKey: "9" },
      { pathname: "/b", sessionId: "s-c", visitorId: "v-c", durationKey: "1" },
      { pathname: "/c", sessionId: "s-d", visitorId: "v-d", durationKey: "1" },
      { pathname: "/d", sessionId: "s-e", visitorId: "v-e", durationKey: "2" },
      { pathname: "/d", sessionId: "s-e", visitorId: "v-e", durationKey: "3" },
    ],
  );
  const selectedPages = filter(
    pages,
    input.volatile
      ? and(neq(pages.columns.pathname, param("")), gt(unixepoch(), param(0)))
      : neq(pages.columns.pathname, param("")),
  );
  const pathRows = aggregate(selectedPages, {
    groupBy: { pathname: selectedPages.columns.pathname },
    aggregates: {
      views: count(),
      sessions: countDistinct(selectedPages.columns.sessionId),
      visitors: countDistinct(selectedPages.columns.visitorId),
      durationKeys: countDistinct(selectedPages.columns.durationKey),
    },
  });
  const sessionPages = filter(
    selectedPages,
    neq(selectedPages.columns.sessionId, param("")),
  );
  const pathSessionRows = aggregate(sessionPages, {
    groupBy: {
      pathname: sessionPages.columns.pathname,
      sessionId: sessionPages.columns.sessionId,
    },
    aggregates: { visitCount: count() },
  });
  const singleVisitRows = filter(
    pathSessionRows,
    eq(pathSessionRows.columns.visitCount, param(1)),
  );
  const bounceRows = aggregate(singleVisitRows, {
    groupBy: { pathname: singleVisitRows.columns.pathname },
    aggregates: { bounces: count() },
  });
  const joined = join(
    pathRows,
    bounceRows,
    eq(pathRows.columns.pathname, bounceRows.columns.pathname),
    "left",
  );
  const bounces = coalesce(joined.columns.right_bounces, constant(0));
  const metrics = project(joined, {
    pathname: joined.columns.left_pathname,
    views: joined.columns.left_views,
    sessions: joined.columns.left_sessions,
    visitors: joined.columns.left_visitors,
    durationKeys: joined.columns.left_durationKeys,
    bounces,
    bounceRate: div(castReal(bounces), joined.columns.left_sessions),
  });
  const selectedMetrics = input.cursor
    ? filter(
        metrics,
        or(
          lt(metrics.columns.bounceRate, param(input.cursor.bounceRate)),
          and(
            eq(metrics.columns.bounceRate, param(input.cursor.bounceRate)),
            lt(metrics.columns.views, param(input.cursor.views)),
          ),
          and(
            eq(metrics.columns.bounceRate, param(input.cursor.bounceRate)),
            eq(metrics.columns.views, param(input.cursor.views)),
            gt(metrics.columns.pathname, param(input.cursor.pathname)),
          ),
        ),
      )
    : metrics;
  const sorted = sort(selectedMetrics, [
    { expression: selectedMetrics.columns.bounceRate, direction: "DESC" },
    { expression: selectedMetrics.columns.views, direction: "DESC" },
    { expression: selectedMetrics.columns.pathname, direction: "ASC" },
  ]);
  const limited =
    input.limit === undefined ? sorted : limit(sorted, input.limit);
  const output = project(limited, {
    pathname: limited.columns.pathname,
    views: limited.columns.views,
    sessions: limited.columns.sessions,
    visitors: limited.columns.visitors,
    durationKeys: limited.columns.durationKeys,
    bounces: limited.columns.bounces,
    bounceRate: limited.columns.bounceRate,
  });
  return { output, selectedPages, pathRows, bounceRows, metrics, sorted };
}

describe("shared relation physical selection", () => {
  it.each([5, 16])(
    "materializes a selective self-contained %i-field relation used three times",
    (width) => {
      const relation = selectedProjection(width);
      const repeated = repeatedThree(relation);
      const physical = lowerLogicalPlan(repeated);
      const definition = physical.sharedRelations.find(
        (shared) => shared.node === relation.node,
      );

      expect(definition).toMatchObject({
        materialization: "materialized",
      });
      expect(definition?.fields).toHaveLength(width);
      const compiled = compileD1Query(physical);
      expect(compiled.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
      expect(compiled.physicalPlanShape?.cteCount).toBe(1);
    },
  );

  it("does not widen the prior narrow or reuse-count policy", () => {
    const narrow = selectedProjection(4);
    const narrowQuery = compileD1Query(repeatedThree(narrow));
    expect(narrowQuery.sql).toContain(" AS (");
    expect(narrowQuery.sql).not.toContain("AS MATERIALIZED");

    const fiveFieldsTwice = selectedProjection(5);
    expect(
      lowerLogicalPlan(union(fiveFieldsTwice, fiveFieldsTwice, true))
        .sharedRelations,
    ).toEqual([]);

    const seventeenFields = selectedProjection(17);
    expect(
      lowerLogicalPlan(repeatedThree(seventeenFields)).sharedRelations,
    ).toEqual([]);

    const identityTable = scan(schema.site_identities);
    const wideInput = project(identityTable, {
      field0: identityTable.columns.site_pk,
      field1: identityTable.columns.site_id,
      field2: identityTable.columns.site_pk,
      field3: identityTable.columns.site_id,
      field4: identityTable.columns.site_pk,
    });
    const selectiveWideFilter = filter(
      wideInput,
      gt(wideInput.columns.field0, param(0)),
    );
    expect(
      lowerLogicalPlan(repeatedThree(selectiveWideFilter)).sharedRelations,
    ).toEqual([]);
  });

  it("shares a repeated four-column aggregate ranking input without changing rows", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    const fullRows = [
      {
        pathname: "/b",
        views: 1,
        sessions: 1,
        visitors: 1,
        durationKeys: 1,
        bounces: 1,
        bounceRate: 1,
      },
      {
        pathname: "/c",
        views: 1,
        sessions: 1,
        visitors: 1,
        durationKeys: 1,
        bounces: 1,
        bounceRate: 1,
      },
      {
        pathname: "/a",
        views: 3,
        sessions: 2,
        visitors: 2,
        durationKeys: 2,
        bounces: 1,
        bounceRate: 0.5,
      },
      {
        pathname: "/d",
        views: 2,
        sessions: 1,
        visitors: 1,
        durationKeys: 2,
        bounces: 0,
        bounceRate: 0,
      },
    ];
    const cases = [
      { input: {}, expected: fullRows },
      { input: { limit: 0 }, expected: [] },
      { input: { limit: 2 }, expected: fullRows.slice(0, 2) },
      {
        input: {
          limit: 2,
          cursor: { bounceRate: 1, views: 1, pathname: "/b" },
        },
        expected: [fullRows[1]!, fullRows[2]!],
      },
    ] as const;

    for (const { input, expected } of cases) {
      const { output, selectedPages } = buildAggregateRankingQuery(input);
      const physical = lowerLogicalPlan(output);
      const shared = physical.sharedRelations.find(
        ({ node }) => node === selectedPages.node,
      );
      expect(shared).toMatchObject({
        materialization: "auto",
        fields: [{}, {}, {}, {}],
      });
      expect(shared?.fields).toHaveLength(4);

      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(output);
      const optimizedRows = database
        .prepare(optimized.sql)
        .all(...(optimized.bindings as SQLInputValue[]));
      const mechanicalRows = database
        .prepare(mechanical.sql)
        .all(...(mechanical.bindings as SQLInputValue[]));
      expect(optimizedRows).toEqual(mechanicalRows);
      expect(optimizedRows).toEqual(expected);
      expect(optimized.physicalPlanShape?.cteCount).toBeGreaterThanOrEqual(1);
      expect(optimized.sql).toContain("_d1_shared_");
    }
  });

  it("recognizes certified aggregate rankings nested in outer relation graphs", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    const base = buildAggregateRankingQuery();
    const supplemental = valuesRelation(
      { pathname: { affinity: "text", nullable: false } },
      [{ pathname: "/a" }],
    );

    const nestedTerminalRanking = join(
      base.output,
      supplemental,
      eq(base.output.columns.pathname, supplemental.columns.pathname),
    );
    const nestedTerminalPhysical = lowerLogicalPlan(nestedTerminalRanking);
    expect(
      nestedTerminalPhysical.sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(true);

    const globalRanked = window(base.metrics, {
      rank: rowNumber({
        orderBy: [
          { expression: base.metrics.columns.views, direction: "DESC" },
        ],
      }),
    });
    const globalSorted = sort(globalRanked, [
      { expression: globalRanked.columns.rank, direction: "ASC" },
    ]);
    const globalLimited = limit(globalSorted, 2);
    const globalOutput = project(globalLimited, {
      pathname: globalLimited.columns.pathname,
      rank: globalLimited.columns.rank,
    });
    const nestedGlobalRanking = join(
      globalOutput,
      supplemental,
      eq(globalOutput.columns.pathname, supplemental.columns.pathname),
    );
    const nestedGlobalPhysical = lowerLogicalPlan(nestedGlobalRanking);
    expect(
      nestedGlobalPhysical.sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(true);

    const expectEquivalentRows = <
      Row extends object,
      Columns extends Readonly<Record<string, AnyExpression>>,
    >(
      query: Relation<Row, Columns>,
    ) => {
      const physical = lowerLogicalPlan(query);
      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(query);
      const optimizedRows = database
        .prepare(optimized.sql)
        .all(...(optimized.bindings as SQLInputValue[]));
      const mechanicalRows = database
        .prepare(mechanical.sql)
        .all(...(mechanical.bindings as SQLInputValue[]));
      expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    };
    expectEquivalentRows(nestedTerminalRanking);
    expectEquivalentRows(nestedGlobalRanking);
  });

  it("rejects aggregate ranking shapes outside the local wrapper and closed aggregate graph", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    const base = buildAggregateRankingQuery();
    const assertNotShared = (query: Parameters<typeof lowerLogicalPlan>[0]) => {
      expect(
        lowerLogicalPlan(query).sharedRelations.some(
          ({ node }) => node === base.selectedPages.node,
        ),
      ).toBe(false);
    };

    const computedRoot = project(base.output, {
      pathname: base.output.columns.pathname,
      views: add(base.output.columns.views, constant(0)),
    });
    expect(
      lowerLogicalPlan(computedRoot).sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(true);

    const offsetLimited = limit(base.sorted, 3, 1);
    const offsetOutput = project(offsetLimited, {
      pathname: offsetLimited.columns.pathname,
      views: offsetLimited.columns.views,
    });
    assertNotShared(offsetOutput);

    const unionedMetrics = union(base.metrics, base.metrics, true);
    const globalUnionLimit = limit(unionedMetrics, 3);
    const unionSorted = sort(globalUnionLimit, [
      {
        expression: globalUnionLimit.columns.bounceRate,
        direction: "DESC",
      },
    ]);
    const unionOutput = project(unionSorted, {
      pathname: unionSorted.columns.pathname,
      views: unionSorted.columns.views,
    });
    assertNotShared(unionOutput);

    const mixedAggregateRawJoin = join(
      base.pathRows,
      base.selectedPages,
      eq(base.pathRows.columns.pathname, base.selectedPages.columns.pathname),
      "left",
    );
    const mixedSorted = sort(mixedAggregateRawJoin, [
      {
        expression: mixedAggregateRawJoin.columns.left_views,
        direction: "DESC",
      },
    ]);
    const mixedOutput = project(mixedSorted, {
      pathname: mixedSorted.columns.left_pathname,
      views: mixedSorted.columns.left_views,
    });
    expect(
      lowerLogicalPlan(mixedOutput).sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(false);
    const mixedPhysical = lowerLogicalPlan(mixedOutput);
    const mixedOptimized = compileD1Query(mixedPhysical);
    const mixedMechanical = compileD1QueryUnoptimizedForTest(mixedOutput);
    expect(
      rowBag(
        database
          .prepare(mixedOptimized.sql)
          .all(...(mixedOptimized.bindings as SQLInputValue[])),
      ),
    ).toEqual(
      rowBag(
        database
          .prepare(mixedMechanical.sql)
          .all(...(mixedMechanical.bindings as SQLInputValue[])),
      ),
    );

    const nestedSort = sort(base.sorted, [
      { expression: base.sorted.columns.bounceRate, direction: "DESC" },
    ]);
    const nestedSortOutput = project(nestedSort, {
      pathname: nestedSort.columns.pathname,
      views: nestedSort.columns.views,
    });
    const nestedSortPhysical = lowerLogicalPlan(nestedSortOutput);
    expect(
      nestedSortPhysical.sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(false);
    const nestedSortOptimized = compileD1Query(nestedSortPhysical);
    const nestedSortMechanical =
      compileD1QueryUnoptimizedForTest(nestedSortOutput);
    expect(
      rowBag(
        database
          .prepare(nestedSortOptimized.sql)
          .all(...(nestedSortOptimized.bindings as SQLInputValue[])),
      ),
    ).toEqual(
      rowBag(
        database
          .prepare(nestedSortMechanical.sql)
          .all(...(nestedSortMechanical.bindings as SQLInputValue[])),
      ),
    );

    const nestedLimit = limit(base.sorted, 2);
    const nestedLimitSort = sort(nestedLimit, [
      { expression: nestedLimit.columns.bounceRate, direction: "DESC" },
    ]);
    const nestedLimitOutput = project(nestedLimitSort, {
      pathname: nestedLimitSort.columns.pathname,
      views: nestedLimitSort.columns.views,
    });
    const nestedLimitPhysical = lowerLogicalPlan(nestedLimitOutput);
    expect(
      nestedLimitPhysical.sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(false);
    const nestedLimitOptimized = compileD1Query(nestedLimitPhysical);
    const nestedLimitMechanical =
      compileD1QueryUnoptimizedForTest(nestedLimitOutput);
    expect(
      rowBag(
        database
          .prepare(nestedLimitOptimized.sql)
          .all(...(nestedLimitOptimized.bindings as SQLInputValue[])),
      ),
    ).toEqual(
      rowBag(
        database
          .prepare(nestedLimitMechanical.sql)
          .all(...(nestedLimitMechanical.bindings as SQLInputValue[])),
      ),
    );

    const windowedMetrics = window(base.metrics, {
      rank: rowNumber({
        orderBy: [
          { expression: base.metrics.columns.views, direction: "DESC" },
        ],
      }),
    });
    const windowSorted = sort(windowedMetrics, [
      { expression: windowedMetrics.columns.bounceRate, direction: "DESC" },
    ]);
    const windowOutput = project(windowSorted, {
      pathname: windowSorted.columns.pathname,
      rank: windowSorted.columns.rank,
    });
    expect(
      lowerLogicalPlan(windowOutput).sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(true);

    const partitionedRankingInput = window(base.metrics, {
      rank: rowNumber({
        partitionBy: [base.metrics.columns.pathname],
        orderBy: [
          { expression: base.metrics.columns.views, direction: "DESC" },
        ],
      }),
    });
    const partitionedRankingSort = sort(partitionedRankingInput, [
      { expression: partitionedRankingInput.columns.rank, direction: "ASC" },
    ]);
    const partitionedRankingLimit = limit(partitionedRankingSort, 2);
    const partitionedRankingOutput = project(partitionedRankingLimit, {
      pathname: partitionedRankingLimit.columns.pathname,
      rank: partitionedRankingLimit.columns.rank,
    });
    assertNotShared(partitionedRankingOutput);

    const scalarSource = project(scan(schema.site_identities), {
      value: constant(1),
    });
    const scalarMetrics = project(base.metrics, {
      pathname: base.metrics.columns.pathname,
      views: base.metrics.columns.views,
      bounceRate: base.metrics.columns.bounceRate,
      lookupValue: scalar(scalarSource),
    });
    const scalarSorted = sort(scalarMetrics, [
      { expression: scalarMetrics.columns.bounceRate, direction: "DESC" },
    ]);
    const scalarOutput = project(scalarSorted, {
      pathname: scalarSorted.columns.pathname,
      views: scalarSorted.columns.views,
      lookupValue: scalarSorted.columns.lookupValue,
    });
    expect(
      lowerLogicalPlan(scalarOutput).sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(false);

    const correlatedIdentities = scan(schema.site_identities);
    const correlatedIdentity = filter(
      correlatedIdentities,
      eq(correlatedIdentities.columns.site_id, base.metrics.columns.pathname),
    );
    const correlatedLookup = project(correlatedIdentity, {
      sitePk: correlatedIdentity.columns.site_pk,
    });
    const correlatedMetrics = project(base.metrics, {
      pathname: base.metrics.columns.pathname,
      views: base.metrics.columns.views,
      bounceRate: base.metrics.columns.bounceRate,
      sitePk: scalar(correlatedLookup),
    });
    const correlatedSorted = sort(correlatedMetrics, [
      {
        expression: correlatedMetrics.columns.bounceRate,
        direction: "DESC",
      },
    ]);
    const correlatedOutput = project(correlatedSorted, {
      pathname: correlatedSorted.columns.pathname,
      views: correlatedSorted.columns.views,
      sitePk: correlatedSorted.columns.sitePk,
    });
    expect(
      lowerLogicalPlan(correlatedOutput).sharedRelations.some(
        ({ node }) => node === base.selectedPages.node,
      ),
    ).toBe(false);

    const volatile = buildAggregateRankingQuery({ volatile: true });
    expect(
      lowerLogicalPlan(volatile.output).sharedRelations.some(
        ({ node }) => node === volatile.selectedPages.node,
      ),
    ).toBe(false);
  });

  it("keeps a shared relation forbidden when a scalar-query edge reaches it in either join order", () => {
    const pages = valuesRelation(
      {
        pathname: { affinity: "text", nullable: false },
        sessionId: { affinity: "text", nullable: false },
        visitorId: { affinity: "text", nullable: false },
        durationKey: { affinity: "text", nullable: false },
      },
      [
        {
          pathname: "/a",
          sessionId: "s-a",
          visitorId: "v-a",
          durationKey: "1",
        },
        {
          pathname: "/a",
          sessionId: "s-b",
          visitorId: "v-b",
          durationKey: "2",
        },
      ],
    );
    const selectedPages = filter(pages, neq(pages.columns.pathname, param("")));
    const querySource = project(selectedPages, {
      pathname: selectedPages.columns.pathname,
    });
    const pageAggregate = aggregate(selectedPages, {
      groupBy: { pathname: selectedPages.columns.pathname },
      aggregates: {
        views: count(),
        scalarVisits: count(scalar(querySource)),
        sessions: countDistinct(selectedPages.columns.sessionId),
      },
    });
    const sessionAggregate = aggregate(selectedPages, {
      groupBy: { pathname: selectedPages.columns.pathname },
      aggregates: {
        views: count(),
        scalarVisits: count(scalar(querySource)),
        sessions: countDistinct(selectedPages.columns.sessionId),
      },
    });

    for (const reverse of [false, true]) {
      const left = reverse ? sessionAggregate : pageAggregate;
      const right = reverse ? pageAggregate : sessionAggregate;
      const joined = join(
        left,
        right,
        eq(left.columns.pathname, right.columns.pathname),
      );
      const sessions = reverse
        ? joined.columns.left_sessions
        : joined.columns.right_sessions;
      const metrics = project(joined, {
        pathname: joined.columns.left_pathname,
        views: joined.columns.left_views,
        sessions,
      });
      const sorted = sort(metrics, [
        { expression: metrics.columns.views, direction: "DESC" },
      ]);
      const limited = limit(sorted, 1);
      const output = project(limited, {
        pathname: limited.columns.pathname,
        views: limited.columns.views,
      });
      expect(
        lowerLogicalPlan(output).sharedRelations.some(
          ({ node }) => node === selectedPages.node,
        ),
      ).toBe(false);
    }
  });

  it("requires selective deterministic input and rejects scope barriers", () => {
    const fullScan = selectedProjection(5, false);
    expect(lowerLogicalPlan(repeatedThree(fullScan)).sharedRelations).toEqual(
      [],
    );

    const identities = scan(schema.site_identities);
    const projected = project(identities, {
      sitePk: identities.columns.site_pk,
      siteId: identities.columns.site_id,
    });
    const filtered = filter(projected, gt(projected.columns.sitePk, param(0)));
    const volatile = project(filtered, {
      field0: filtered.columns.sitePk,
      field1: filtered.columns.siteId,
      field2: unixepoch(),
      field3: filtered.columns.sitePk,
      field4: filtered.columns.siteId,
    });
    expect(lowerLogicalPlan(repeatedThree(volatile)).sharedRelations).toEqual(
      [],
    );

    const safe = selectedProjection(5);
    const branches = union(union(safe, safe, true), safe, true);
    const limitedRoot = limit(branches, 10);
    expect(lowerLogicalPlan(limitedRoot).sharedRelations).toEqual([]);

    const branchSorted = sort(safe, [
      { expression: safe.columns.field0, direction: "ASC" },
    ]);
    const mixedSorted = union(union(branchSorted, safe, true), safe, true);
    expect(lowerLogicalPlan(mixedSorted).sharedRelations).toEqual([]);
  });

  it("materializes safe narrow inputs reused below independent windows", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("window-site-b", "window-site-a");

    const identities = scan(schema.site_identities);
    const identityColumns = project(identities, {
      siteId: identities.columns.site_id,
      sitePk: identities.columns.site_pk,
    });
    const selectiveIdentities = filter(
      identityColumns,
      gt(identityColumns.columns.sitePk, param(0)),
    );
    const byKey = window(selectiveIdentities, {
      rank: rowNumber({
        orderBy: [
          { expression: selectiveIdentities.columns.sitePk, direction: "ASC" },
        ],
      }),
    });
    const bySite = window(selectiveIdentities, {
      rank: rowNumber({
        partitionBy: [selectiveIdentities.columns.siteId],
        orderBy: [
          { expression: selectiveIdentities.columns.sitePk, direction: "ASC" },
        ],
      }),
    });
    const twoRanks = union(byKey, bySite, true);
    const physical = lowerLogicalPlan(twoRanks);
    expect(
      physical.sharedRelations.find(
        ({ node }) => node === selectiveIdentities.node,
      ),
    ).toMatchObject({ materialization: "materialized", fields: [{}, {}] });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(twoRanks);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows.map((row) => row.rank)).toEqual([1, 2, 1, 1]);

    const visits = scan(schema.visits);
    const visitColumns = project(visits, {
      visitId: visits.columns.visit_id,
      startedAt: visits.columns.started_at,
    });
    const selectiveVisits = filter(
      visitColumns,
      gt(visitColumns.columns.startedAt, param(0)),
    );
    const byStartedAt = window(selectiveVisits, {
      rank: rowNumber({
        orderBy: [
          { expression: selectiveVisits.columns.startedAt, direction: "ASC" },
        ],
      }),
    });
    const byVisitId = window(selectiveVisits, {
      rank: rowNumber({
        partitionBy: [selectiveVisits.columns.visitId],
        orderBy: [
          { expression: selectiveVisits.columns.startedAt, direction: "DESC" },
        ],
      }),
    });
    const visitPlan = lowerLogicalPlan(union(byStartedAt, byVisitId, true));
    expect(
      visitPlan.sharedRelations.find(
        ({ node }) => node === selectiveVisits.node,
      ),
    ).toMatchObject({ materialization: "materialized", fields: [{}, {}] });
  });

  it("materializes a safe five-field input shared by two distinct windows only", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("wide-window-b", "wide-window-a");

    const wide = selectedProjection(5);
    const byPk = window(wide, {
      rank: rowNumber({
        orderBy: [{ expression: wide.columns.field0, direction: "ASC" }],
      }),
    });
    const bySite = window(wide, {
      rank: rowNumber({
        partitionBy: [wide.columns.field1],
        orderBy: [{ expression: wide.columns.field0, direction: "DESC" }],
      }),
    });
    const twoWindows = union(byPk, bySite, true);
    const physical = lowerLogicalPlan(twoWindows);
    expect(
      physical.sharedRelations.find(({ node }) => node === wide.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: [{}, {}, {}, {}, {}],
    });

    const optimized = compileD1Query(physical);
    const repeated = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(twoWindows);
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(repeated.sql).toBe(optimized.sql);
    expect(repeated.bindings).toEqual(optimized.bindings);
    expect(repeated.physicalPlanShape).toEqual(optimized.physicalPlanShape);
    const run = (query: { sql: string; bindings?: readonly unknown[] }) =>
      database
        .prepare(query.sql)
        .all(...((query.bindings ?? []) as SQLInputValue[]));
    expect(run(optimized)).toEqual(run(mechanical));

    const noWindowCandidate = selectedProjection(5);
    expect(
      lowerLogicalPlan(union(noWindowCandidate, noWindowCandidate, true))
        .sharedRelations,
    ).toEqual([]);

    const sameWindowInput = selectedProjection(5);
    const oneWindow = window(sameWindowInput, {
      rank: rowNumber({
        orderBy: [
          { expression: sameWindowInput.columns.field0, direction: "ASC" },
        ],
      }),
    });
    expect(
      lowerLogicalPlan(union(oneWindow, oneWindow, true)).sharedRelations,
    ).toEqual([]);
    expect(lowerLogicalPlan(oneWindow).sharedRelations).toEqual([]);

    for (const safeFirst of [true, false]) {
      const expressionCandidate = selectedProjection(5);
      const expressionByPk = window(expressionCandidate, {
        rank: rowNumber({
          orderBy: [
            {
              expression: expressionCandidate.columns.field0,
              direction: "ASC",
            },
          ],
        }),
      });
      const expressionBySite = window(expressionCandidate, {
        rank: rowNumber({
          partitionBy: [expressionCandidate.columns.field1],
          orderBy: [
            {
              expression: expressionCandidate.columns.field0,
              direction: "DESC",
            },
          ],
        }),
      });
      const safeWindows = union(expressionByPk, expressionBySite, true);
      const scalarReader = project(scan(schema.site_identities), {
        value: scalar(project(expressionCandidate, { value: constant(1) })),
      });
      const assertUnsharedUnderWrappedSort = (
        combined: Relation,
        sortExpression: AnyExpression,
      ) => {
        const ordered = sort(combined, [
          { expression: sortExpression, direction: "ASC" },
        ]);
        const output: Record<string, AnyExpression> = {};
        for (const [name, expression] of Object.entries(ordered.columns))
          output[name] = expression;
        const wrapped = project(ordered, output);

        expect(
          lowerLogicalPlan(wrapped).sharedRelations.some(
            ({ node }) => node === expressionCandidate.node,
          ),
        ).toBe(false);
      };

      if (safeFirst) {
        const combined = join(
          safeWindows,
          scalarReader,
          eq(param(1), param(1)),
        );
        assertUnsharedUnderWrappedSort(combined, combined.columns.left_field0);
      } else {
        const combined = join(
          scalarReader,
          safeWindows,
          eq(param(1), param(1)),
        );
        assertUnsharedUnderWrappedSort(combined, combined.columns.right_field0);
      }
    }
  });

  it("does not share a window candidate or inputs behind inherited barriers", () => {
    const base = selectedProjection(2);
    const ranked = window(base, {
      rank: rowNumber({
        orderBy: [{ expression: base.columns.field0, direction: "ASC" }],
      }),
    });
    expect(
      lowerLogicalPlan(union(ranked, ranked, true)).sharedRelations,
    ).toEqual([]);

    const filtered = selectedProjection(2);
    const firstRank = window(filtered, {
      rank: rowNumber({
        orderBy: [{ expression: filtered.columns.field0, direction: "ASC" }],
      }),
    });
    const secondRank = window(filtered, {
      rank: rowNumber({
        partitionBy: [filtered.columns.field1],
        orderBy: [{ expression: filtered.columns.field0, direction: "DESC" }],
      }),
    });
    expect(
      lowerLogicalPlan(limit(union(firstRank, secondRank, true), 10))
        .sharedRelations,
    ).toEqual([]);

    const windowSource = scan(schema.site_identities);
    const windowInput = project(windowSource, {
      sitePk: windowSource.columns.site_pk,
      siteId: windowSource.columns.site_id,
    });
    const safeWindowInput = filter(
      windowInput,
      gt(windowInput.columns.sitePk, param(0)),
    );
    const rankOne = window(safeWindowInput, {
      rank: rowNumber({
        orderBy: [
          { expression: safeWindowInput.columns.sitePk, direction: "ASC" },
        ],
      }),
    });
    const rankTwo = window(safeWindowInput, {
      rank: rowNumber({
        orderBy: [
          { expression: safeWindowInput.columns.siteId, direction: "ASC" },
        ],
      }),
    });
    const sortedBranch = sort(rankTwo, [
      { expression: rankTwo.columns.rank, direction: "ASC" },
    ]);
    expect(
      lowerLogicalPlan(union(rankOne, sortedBranch, true)).sharedRelations,
    ).toEqual([]);
  });

  it("materializes a narrow selective candidate containing only row-number windows", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("row-number-site-b", "row-number-site-a");

    const source = selectedProjection(2);
    const ranked = window(source, {
      rank: rowNumber({
        orderBy: [{ expression: source.columns.field0, direction: "ASC" }],
      }),
    });
    const candidate = filter(ranked, gt(ranked.columns.rank, param(0)));
    const query = repeatedThree(candidate);
    const physical = lowerLogicalPlan(query);
    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node),
    ).toMatchObject({ materialization: "materialized", fields: [{}, {}, {}] });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(query);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(optimizedRows).toEqual(mechanicalRows);

    const counted = window(source, { rows: windowCountRows() });
    const countCandidate = filter(counted, gt(counted.columns.rows, param(0)));
    expect(
      lowerLogicalPlan(repeatedThree(countCandidate)).sharedRelations.some(
        ({ node }) => node === countCandidate.node,
      ),
    ).toBe(false);
  });

  it("shares selective inputs below independent branch-local top-N sorts", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("top-n-site-b", "top-n-site-a");

    const source = selectedProjection(5);
    const branches = [0, 1, 2].map((index) =>
      limit(
        sort(source, [
          {
            expression: source.columns[`field${index}`]!,
            direction: index === 1 ? "DESC" : "ASC",
          },
        ]),
        1,
      ),
    );
    const combined = union(
      union(branches[0]!, branches[1]!, true),
      branches[2]!,
      true,
    );
    const physical = lowerLogicalPlan(combined);
    expect(
      physical.sharedRelations.find(({ node }) => node === source.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: [{}, {}, {}, {}, {}],
    });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(combined);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(optimizedRows).toEqual(mechanicalRows);

    const globalLimit = limit(
      union(union(source, source, true), source, true),
      2,
    );
    expect(lowerLogicalPlan(globalLimit).sharedRelations).toEqual([]);
  });

  it("keeps Top-N sharing independent of branch traversal order", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run("top-n-null-site");
    const { site_pk: sitePk } = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("top-n-null-site") as { site_pk: number };
    const inserts = database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, ended_at, duration_ms, duration_source, exit_reason,
        pathname, hostname, site_pk
      ) VALUES (?, 'top-n-null-site', ?, ?, 'complete', ?, ?, ?, ?, ?, ?, '/', 'example.test', ?)`,
    );
    inserts.run(
      "row-a",
      "visitor-a",
      "session-a",
      1,
      1,
      null,
      null,
      null,
      null,
      sitePk,
    );
    inserts.run(
      "row-b",
      "visitor-b",
      "session-b",
      2,
      2,
      null,
      null,
      "same",
      null,
      sitePk,
    );
    inserts.run(
      "row-c",
      "visitor-c",
      "session-c",
      3,
      3,
      10,
      20,
      "duration",
      "same",
      sitePk,
    );
    inserts.run(
      "row-d",
      "visitor-d",
      "session-d",
      4,
      4,
      10,
      20,
      "duration",
      "same",
      sitePk,
    );

    for (const safeFirst of [true, false]) {
      const source = nullablePageProjection();
      const sharedSort = sort(source, [
        { expression: source.columns.field0, direction: "ASC" },
      ]);
      const topN = limit(sharedSort, 2);
      const ordinarySort = sharedSort;
      const combined = safeFirst
        ? union(
            union(union(topN, ordinarySort, true), source, true),
            source,
            true,
          )
        : union(
            union(union(ordinarySort, topN, true), source, true),
            source,
            true,
          );
      const physical = lowerLogicalPlan(combined);
      expect(
        physical.sharedRelations.find(({ node }) => node === source.node),
      ).toBeUndefined();

      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(combined);
      const optimizedRows = database
        .prepare(optimized.sql)
        .all(...(optimized.bindings as SQLInputValue[]));
      const mechanicalRows = database
        .prepare(mechanical.sql)
        .all(...(mechanical.bindings as SQLInputValue[]));
      expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
      expect(
        optimizedRows.some((row) => Object.values(row).includes(null)),
      ).toBe(true);
    }

    const globalSource = selectedProjection(5);
    const globalLimit = limit(
      union(union(globalSource, globalSource, true), globalSource, true),
      2,
    );
    const wrappedGlobalLimit = project(globalLimit, {
      field0: globalLimit.columns.field0,
      field1: globalLimit.columns.field1,
      field2: globalLimit.columns.field2,
      field3: globalLimit.columns.field3,
      field4: globalLimit.columns.field4,
    });
    expect(lowerLogicalPlan(wrappedGlobalLimit).sharedRelations).toEqual([]);

    const nestedSource = selectedProjection(5);
    const innerSort = sort(nestedSource, [
      { expression: nestedSource.columns.field0, direction: "ASC" },
    ]);
    const outerSort = sort(innerSort, [
      { expression: innerSort.columns.field1, direction: "DESC" },
    ]);
    const nestedTopN = limit(outerSort, 1);
    const nestedSelection = union(
      union(union(nestedTopN, nestedSource, true), nestedSource, true),
      nestedSource,
      true,
    );
    expect(
      lowerLogicalPlan(nestedSelection).sharedRelations.find(
        ({ node }) => node === nestedSource.node,
      ),
    ).toBeUndefined();
  });

  it("allows a terminal root sort and preserves UNION ALL order and multiplicity", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("site-b", "site-a");
    const relation = selectedProjection(5);
    const repeated = repeatedThree(relation);
    const ordered = sort(repeated, [
      { expression: repeated.columns.field1, direction: "ASC" },
    ]);
    const output = project(ordered, {
      field0: ordered.columns.field0,
      field2: ordered.columns.field2,
      field4: ordered.columns.field4,
    });
    const physical = lowerLogicalPlan(output);
    const selected = physical.sharedRelations.find(
      (shared) => shared.node === relation.node,
    );
    expect(selected?.materialization).toBe("materialized");

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(optimized.sql.lastIndexOf("ORDER BY")).toBeGreaterThan(
      optimized.sql.lastIndexOf("UNION ALL"),
    );
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(6);

    const forged = {
      ...physical,
      sharedRelations: physical.sharedRelations.map((shared) => ({
        ...shared,
        materialization: "auto" as const,
      })),
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("allows a wrapped terminal sort over UNION ALL through pure output projections", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("wrapped-sort-b", "wrapped-sort-a");

    const source = selectedProjection(5);
    const repeated = union(union(source, source, true), source, true);
    const ordered = sort(repeated, [
      { expression: repeated.columns.field1!, direction: "ASC" },
    ]);
    const wrapped = project(ordered, {
      field0: ordered.columns.field0!,
      field1: ordered.columns.field1!,
      field2: ordered.columns.field2!,
      field3: ordered.columns.field3!,
      field4: ordered.columns.field4!,
    });
    const physical = lowerLogicalPlan(wrapped);
    expect(
      physical.sharedRelations.find(({ node }) => node === source.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: [{}, {}, {}, {}, {}],
    });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(wrapped);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(6);

    const filteredRoot = filter(ordered, eq(param(1), param(1)));
    expect(
      lowerLogicalPlan(filteredRoot).sharedRelations.some(
        ({ node }) => node === source.node,
      ),
    ).toBe(false);

    const expressionRoot = project(ordered, {
      field0: ordered.columns.field0!,
      marker: constant("expression"),
    });
    expect(
      lowerLogicalPlan(expressionRoot).sharedRelations.some(
        ({ node }) => node === source.node,
      ),
    ).toBe(false);

    const limited = limit(ordered, 2);
    const projectedLimit = project(limited, {
      field0: limited.columns.field0!,
      field1: limited.columns.field1!,
      field2: limited.columns.field2!,
      field3: limited.columns.field3!,
      field4: limited.columns.field4!,
    });
    expect(
      lowerLogicalPlan(projectedLimit).sharedRelations.some(
        ({ node }) => node === source.node,
      ),
    ).toBe(false);
  });

  it("keeps wrapped sorts over noncompound and UNION DISTINCT inputs behind the old barrier", () => {
    const noncompoundSource = selectedProjection(5);
    const noncompoundAliases = Array.from({ length: 3 }, () =>
      project(noncompoundSource, {
        field0: noncompoundSource.columns.field0!,
        field1: noncompoundSource.columns.field1!,
        field2: noncompoundSource.columns.field2!,
        field3: noncompoundSource.columns.field3!,
        field4: noncompoundSource.columns.field4!,
      }),
    );
    const noncompoundPair = join(
      noncompoundAliases[0]!,
      noncompoundAliases[1]!,
      eq(
        noncompoundAliases[0]!.columns.field0!,
        noncompoundAliases[1]!.columns.field0!,
      ),
    );
    const noncompoundRepeated = join(
      noncompoundPair,
      noncompoundAliases[2]!,
      eq(
        noncompoundPair.columns.left_field0!,
        noncompoundAliases[2]!.columns.field0!,
      ),
    );
    const noncompoundSort = sort(noncompoundRepeated, [
      {
        expression: noncompoundRepeated.columns.right_field1!,
        direction: "ASC",
      },
    ]);
    const noncompoundOutput = project(noncompoundSort, {
      field1: noncompoundSort.columns.right_field1!,
    });
    expect(
      lowerLogicalPlan(noncompoundOutput).sharedRelations.some(
        ({ node }) => node === noncompoundSource.node,
      ),
    ).toBe(false);

    const distinctSource = selectedProjection(5);
    const distinctRepeated = union(
      union(distinctSource, distinctSource, false),
      distinctSource,
      false,
    );
    const distinctSort = sort(distinctRepeated, [
      { expression: distinctRepeated.columns.field1!, direction: "ASC" },
    ]);
    const distinctOutput = project(distinctSort, {
      field0: distinctSort.columns.field0!,
      field1: distinctSort.columns.field1!,
      field2: distinctSort.columns.field2!,
      field3: distinctSort.columns.field3!,
      field4: distinctSort.columns.field4!,
    });
    expect(
      lowerLogicalPlan(distinctOutput).sharedRelations.some(
        ({ node }) => node === distinctSource.node,
      ),
    ).toBe(false);
  });

  it("materializes only bounded wide selective inputs reused by eight independent windows", () => {
    const database = createMigratedDatabase();
    databases.add(database);

    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run("wide-window-site");
    const { site_pk: sitePk } = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("wide-window-site") as { site_pk: number };
    const insertVisit = database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, ended_at, duration_ms, duration_source, exit_reason,
        pathname, hostname, site_pk
      ) VALUES (?, 'wide-window-site', ?, ?, 'complete', ?, ?, ?, ?, ?, ?, '/', 'example.test', ?)`,
    );
    insertVisit.run(
      "wide-duplicate-a",
      "wide-duplicate-visitor",
      "wide-duplicate-session",
      1,
      1,
      10,
      20,
      "duration",
      "same",
      sitePk,
    );
    insertVisit.run(
      "wide-duplicate-b",
      "wide-duplicate-visitor",
      "wide-duplicate-session",
      2,
      2,
      10,
      20,
      "duration",
      "same",
      sitePk,
    );
    insertVisit.run(
      "wide-null-row",
      "wide-null-visitor",
      "wide-null-session",
      3,
      3,
      null,
      null,
      null,
      null,
      sitePk,
    );
    const narrowSource = nullablePageProjection();
    const wideFields: Record<string, AnyExpression> = {};
    for (let index = 0; index < 17; index += 1)
      wideFields[`field${index}`] = Object.values(narrowSource.columns)[
        index % 5
      ]!;
    const source = project(narrowSource, wideFields);
    const windows = independentWindowUnion(source, 8);
    const ordered = sort(windows, [
      { expression: windows.columns.field0!, direction: "ASC" },
      { expression: windows.columns.rank!, direction: "ASC" },
    ]);
    const output: Record<string, AnyExpression> = {};
    for (const name of Object.keys(ordered.columns))
      output[name] = ordered.columns[name]!;
    const wrapped = project(ordered, output);
    const physical = lowerLogicalPlan(wrapped);
    expect(
      physical.sharedRelations.find(({ node }) => node === source.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: Array.from({ length: 17 }, () => ({})),
    });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(wrapped);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    const queryPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${optimized.sql}`)
      .all(...(optimized.bindings as SQLInputValue[])) as Array<{
      detail: string;
    }>;
    const details = queryPlan.map(({ detail }) => detail);

    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(
      details.filter((detail) => detail.includes("MATERIALIZE _d1_shared_0")),
    ).toHaveLength(1);
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(24);
    expect(optimizedRows.some((row) => Object.values(row).includes(null))).toBe(
      true,
    );

    for (const width of [17, 32]) {
      const candidate = selectedWideTextProjection(width);
      const query = independentWindowUnion(candidate, 8);
      expect(
        lowerLogicalPlan(query).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(true);
    }

    for (const [width, count] of [
      [33, 8],
      [17, 7],
    ] as const) {
      const candidate = selectedWideTextProjection(width);
      const query = independentWindowUnion(candidate, count);
      expect(
        lowerLogicalPlan(query).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(false);
    }

    const narrowLegacy = selectedProjection(16);
    expect(
      lowerLogicalPlan(
        independentWindowUnion(narrowLegacy, 8),
      ).sharedRelations.some(({ node }) => node === narrowLegacy.node),
    ).toBe(true);

    const oneWindowInput = selectedWideTextProjection(17);
    const oneWindow = window(oneWindowInput, {
      rank: rowNumber({
        orderBy: [
          { expression: oneWindowInput.columns.field0!, direction: "ASC" },
        ],
      }),
    });
    const repeatedOneWindow = Array.from({ length: 8 }, () => oneWindow)
      .slice(1)
      .reduce((combined, branch) => union(combined, branch, true), oneWindow);
    expect(
      lowerLogicalPlan(repeatedOneWindow).sharedRelations.some(
        ({ node }) => node === oneWindowInput.node,
      ),
    ).toBe(false);

    const nonselective = selectedWideTextProjection(17, false);
    expect(
      lowerLogicalPlan(
        independentWindowUnion(nonselective, 8),
      ).sharedRelations.some(({ node }) => node === nonselective.node),
    ).toBe(false);

    const nonProjectInput = selectedWideTextProjection(17);
    const nonProject = filter(nonProjectInput, eq(param(1), param(1)));
    expect(
      lowerLogicalPlan(
        independentWindowUnion(nonProject, 8),
      ).sharedRelations.some(({ node }) => node === nonProject.node),
    ).toBe(false);

    const rankSource = selectedWideTextProjection(17);
    const innerRank = window(rankSource, {
      rank: rowNumber({
        orderBy: [{ expression: rankSource.columns.field0!, direction: "ASC" }],
      }),
    });
    const rankColumns: Record<string, AnyExpression> = {};
    for (let index = 0; index < 16; index += 1)
      rankColumns[`field${index}`] = innerRank.columns[`field${index}`]!;
    rankColumns.field16 = innerRank.columns.rank!;
    const rowNumberResult = project(innerRank, rankColumns);
    expect(
      lowerLogicalPlan(
        independentWindowUnion(rowNumberResult, 8),
      ).sharedRelations.some(({ node }) => node === rowNumberResult.node),
    ).toBe(false);

    for (const safeFirst of [true, false]) {
      const barrierSource = selectedWideTextProjection(17);
      const safeWindows = independentWindowUnion(barrierSource, 8);
      const windowColumns: Record<string, AnyExpression> = {};
      for (let index = 0; index < 17; index += 1)
        windowColumns[`field${index}`] = safeWindows.columns[`field${index}`]!;
      const safeRows = project(safeWindows, windowColumns);
      const sortedBranch = sort(barrierSource, [
        { expression: barrierSource.columns.field0!, direction: "ASC" },
      ]);
      const combined = safeFirst
        ? union(safeRows, sortedBranch, true)
        : union(sortedBranch, safeRows, true);
      expect(
        lowerLogicalPlan(combined).sharedRelations.some(
          ({ node }) => node === barrierSource.node,
        ),
      ).toBe(false);
    }

    const limitSource = selectedWideTextProjection(17);
    expect(
      lowerLogicalPlan(
        limit(independentWindowUnion(limitSource, 8), 4),
      ).sharedRelations.some(({ node }) => node === limitSource.node),
    ).toBe(false);

    for (const safeLeft of [true, false]) {
      const expressionSource = selectedWideTextProjection(17);
      const safeWindows = independentWindowUnion(expressionSource, 8);
      const scalarReader = project(scan(schema.site_identities), {
        value: scalar(project(expressionSource, { value: constant(1) })),
      });
      const combined: Relation = safeLeft
        ? join(safeWindows, scalarReader, eq(param(1), param(1)))
        : join(scalarReader, safeWindows, eq(param(1), param(1)));
      expect(
        lowerLogicalPlan(combined).sharedRelations.some(
          ({ node }) => node === expressionSource.node,
        ),
      ).toBe(false);
    }
  });

  it("shares independent branch Top-N inputs below a terminal root sort", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?), (?)")
      .run("terminal-top-n-a", "terminal-top-n-b", "terminal-top-n-c");

    const source = selectedProjection(5);
    const branches = [
      limit(
        sort(source, [
          { expression: source.columns.field0!, direction: "ASC" },
        ]),
        1,
      ),
      limit(
        sort(source, [
          { expression: source.columns.field1!, direction: "DESC" },
        ]),
        1,
      ),
      limit(
        sort(source, [
          { expression: source.columns.field0!, direction: "DESC" },
        ]),
        1,
      ),
    ];
    const combined = union(
      union(branches[0]!, branches[1]!, true),
      branches[2]!,
      true,
    );
    const ordered = sort(combined, [
      { expression: combined.columns.field1!, direction: "ASC" },
    ]);
    const physical = lowerLogicalPlan(ordered);

    expect(
      physical.sharedRelations.find(({ node }) => node === source.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: [{}, {}, {}, {}, {}],
    });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(ordered);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(3);
  });

  it("shares correlated constant-existence Top-N inputs without changing rows", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run("constant-existence-site");
    const { site_pk: sitePk } = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("constant-existence-site") as { site_pk: number };
    const insertVisit = database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, ended_at, duration_ms, duration_source, exit_reason,
        pathname, hostname, site_pk
      ) VALUES (?, 'constant-existence-site', ?, ?, 'complete', ?, ?, ?, ?, 'duration', 'normal', ?, 'example.test', ?)`,
    );
    for (const [
      visitId,
      sessionId,
      startedAt,
      endedAt,
      durationMs,
      pathname,
    ] of [
      ["exist-empty", "a-empty", 1, null, 10, "/not-match"],
      ["exist-one", "b-one", 2, 20, 20, "/match"],
      ["exist-many-1", "c-many", 3, 30, 30, "/match"],
      ["exist-many-2", "c-many", 4, 30, 30, "/match"],
    ] as const) {
      insertVisit.run(
        visitId,
        `visitor-${sessionId}`,
        sessionId,
        startedAt,
        startedAt,
        endedAt,
        durationMs,
        pathname,
        sitePk,
      );
    }

    const visits = scan(schema.visits);
    const selected = filter(
      visits,
      eq(visits.columns.status, param("complete")),
    );
    const lookup = scan(schema.visits);
    const matching = filter(
      lookup,
      and(
        eq(lookup.columns.session_id, selected.columns.session_id),
        eq(lookup.columns.pathname, param("/match")),
      ),
    );
    const source = project(selected, {
      field0: selected.columns.ended_at,
      field1: selected.columns.duration_ms,
      field2: selected.columns.session_id,
      field3: selected.columns.pathname,
      field4: isNotNull(scalar(project(matching, { found: constant(1) }))),
    });
    const branches = [
      limit(
        sort(source, [{ expression: source.columns.field0, direction: "ASC" }]),
        2,
      ),
      limit(
        sort(source, [
          { expression: source.columns.field1, direction: "DESC" },
        ]),
        2,
      ),
      limit(
        sort(source, [{ expression: source.columns.field2, direction: "ASC" }]),
        2,
      ),
    ];
    const combined = union(
      union(branches[0]!, branches[1]!, true),
      branches[2]!,
      true,
    );
    const ordered = sort(combined, [
      { expression: combined.columns.field2, direction: "ASC" },
      { expression: combined.columns.field1, direction: "ASC" },
    ]);
    const physical = lowerLogicalPlan(ordered);

    expect(
      physical.sharedRelations.find(({ node }) => node === source.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: [{}, {}, {}, {}, {}],
    });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(ordered);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(6);
    expect(optimizedRows.map((row) => row.field4)).toContain(0);
    expect(optimizedRows.map((row) => row.field4)).toContain(1);
    expect(optimizedRows.filter((row) => row.field2 === "c-many")).toHaveLength(
      2,
    );
  });

  it("shares a repeated selection containing a closed constant-existence row-number window", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    const { candidate, existence, innerPages, outerPages, ranked } =
      closedConstantExistenceWindowCandidate();
    const repeated = union(
      union(union(candidate, candidate, true), candidate, true),
      candidate,
      true,
    );
    const ordered = sort(repeated, [
      { expression: repeated.columns.startedAt, direction: "ASC" },
    ]);
    const output = project(ordered, {
      sitePk: ordered.columns.sitePk,
      sessionId: ordered.columns.sessionId,
      startedAt: ordered.columns.startedAt,
    });
    const physical = lowerLogicalPlan(output);

    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      physical.sharedRelations.some(
        ({ node }) =>
          node === existence.node ||
          node === innerPages.node ||
          node === outerPages.node ||
          node === ranked.node,
      ),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(8);
    expect(optimizedRows.map((row) => row.startedAt)).toEqual(
      Array<string>(8).fill("11"),
    );
    expect(optimizedRows.every((row) => row.sessionId === "session-a")).toBe(
      true,
    );
    expect(optimizedRows.every((row) => row.sitePk === "1")).toBe(true);
  });

  it("keeps nonclosed or unsafe constant-existence window shapes unshared", () => {
    for (const options of [
      { windowInputCorrelation: "input" },
      { windowInputCorrelation: "partition" },
      { windowInputCorrelation: "order" },
      { windowKind: "count-rows" },
      { barrier: "sort" },
      { barrier: "limit" },
      { nestedNonconstantQuery: true },
      { queryKind: "in" },
    ] as const) {
      const { candidate } = closedConstantExistenceWindowCandidate(options);
      let physical: ReturnType<typeof lowerLogicalPlan> | undefined;
      try {
        physical = lowerLogicalPlan(repeatedThree(candidate));
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_plan" });
      }
      expect(
        physical?.sharedRelations.some(({ node }) => node === candidate.node) ??
          false,
      ).toBe(false);
    }
  });

  it("lets a forbidden scalar-query path veto a safe reuse in either join order", () => {
    for (const safeFirst of [true, false]) {
      const { candidate } = closedConstantExistenceWindowCandidate();
      const safeReuse = repeatedThree(candidate);
      const query = project(candidate, {
        value: candidate.columns.sitePk,
      });
      const lookupRows = valuesRelation(
        { marker: { affinity: "text", nullable: false } },
        [{ marker: "lookup" }],
      );
      const lookup = project(lookupRows, {
        marker: lookupRows.columns.marker,
        value: scalar(query),
      });
      const assertForbidden = (combined: Relation) => {
        const physical = lowerLogicalPlan(combined);
        expect(
          physical.sharedRelations.some(({ node }) => node === candidate.node),
        ).toBe(false);
      };
      if (safeFirst) {
        assertForbidden(
          join(
            safeReuse,
            lookup,
            eq(safeReuse.columns.sitePk, lookup.columns.value),
          ),
        );
      } else {
        assertForbidden(
          join(
            lookup,
            safeReuse,
            eq(lookup.columns.value, safeReuse.columns.sitePk),
          ),
        );
      }
    }
  });

  it("keeps unsafe scalar-subquery shapes out of shared relations", () => {
    const expectUnshared = (candidate: Relation) => {
      const physical = lowerLogicalPlan(repeatedThree(candidate));
      expect(
        physical.sharedRelations.find(({ node }) => node === candidate.node),
      ).toBeUndefined();
    };
    const makeCandidate = (
      kind: "value" | "computed" | "external" | "limit" | "window" | "volatile",
    ) => {
      const visits = scan(schema.visits);
      const selected = filter(
        visits,
        eq(visits.columns.status, param("complete")),
      );
      const lookup = scan(schema.visits);
      let value: AnyExpression;
      if (kind === "external") {
        const outside = scan(schema.visits);
        const matching = filter(
          lookup,
          eq(lookup.columns.session_id, outside.columns.session_id),
        );
        value = isNotNull(scalar(project(matching, { found: constant(1) })));
      } else {
        const matching = filter(
          lookup,
          kind === "volatile"
            ? and(
                eq(lookup.columns.session_id, selected.columns.session_id),
                eq(unixepoch(), param(0)),
              )
            : eq(lookup.columns.session_id, selected.columns.session_id),
        );
        if (kind === "value") {
          value = isNotNull(
            scalar(project(matching, { value: matching.columns.visit_id })),
          );
        } else if (kind === "computed") {
          value = isNotNull(
            scalar(
              project(matching, {
                value: add(matching.columns.site_pk, constant(1)),
              }),
            ),
          );
        } else if (kind === "limit") {
          value = isNotNull(
            scalar(project(limit(matching, 1), { found: constant(1) })),
          );
        } else if (kind === "window") {
          const ranked = window(matching, {
            rank: rowNumber({
              orderBy: [
                { expression: matching.columns.visit_id, direction: "ASC" },
              ],
            }),
          });
          value = isNotNull(scalar(project(ranked, { found: constant(1) })));
        } else {
          value = isNotNull(scalar(project(matching, { found: constant(1) })));
        }
      }
      return project(selected, {
        field0: selected.columns.ended_at,
        field1: selected.columns.duration_ms,
        field2: selected.columns.session_id,
        field3: selected.columns.pathname,
        field4: value,
      });
    };
    for (const kind of [
      "value",
      "computed",
      "limit",
      "window",
      "volatile",
    ] as const)
      expectUnshared(makeCandidate(kind));

    expect(() =>
      lowerLogicalPlan(repeatedThree(makeCandidate("external"))),
    ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));

    const multipleFields = project(scan(schema.visits), {
      first: constant(1),
      second: constant(1),
    });
    expect(() => scalar(multipleFields)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});
