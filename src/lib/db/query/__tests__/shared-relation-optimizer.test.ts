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
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
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

  it("rejects aggregate ranking shapes outside the local wrapper and closed aggregate graph", () => {
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
    assertNotShared(computedRoot);

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
    assertNotShared(mixedOutput);

    const nestedSort = sort(base.sorted, [
      { expression: base.sorted.columns.bounceRate, direction: "DESC" },
    ]);
    const nestedSortOutput = project(nestedSort, {
      pathname: nestedSort.columns.pathname,
      views: nestedSort.columns.views,
    });
    assertNotShared(nestedSortOutput);

    const nestedLimit = limit(base.sorted, 2);
    const nestedLimitSort = sort(nestedLimit, [
      { expression: nestedLimit.columns.bounceRate, direction: "DESC" },
    ]);
    const nestedLimitOutput = project(nestedLimitSort, {
      pathname: nestedLimitSort.columns.pathname,
      views: nestedLimitSort.columns.views,
    });
    assertNotShared(nestedLimitOutput);

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
    assertNotShared(windowOutput);

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
    assertNotShared(scalarOutput);

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
    assertNotShared(correlatedOutput);

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
    const physical = lowerLogicalPlan(ordered);
    const selected = physical.sharedRelations.find(
      (shared) => shared.node === relation.node,
    );
    expect(selected?.materialization).toBe("materialized");

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(ordered);
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
