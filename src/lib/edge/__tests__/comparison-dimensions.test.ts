import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type FilterScope,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { scopedDatasetFor } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument as RawFilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import type { FilterScopePreference } from "@/lib/filter-contract/scope-preference";

const SITE_ID = "comparison-dimensions-test";
const current: QueryWindow = {
  startMs: 1_000,
  endExclusiveMs: 2_000,
  nowMs: 3_000,
  timeZone: "UTC",
};
const reference: QueryWindow = {
  startMs: 4_000,
  endExclusiveMs: 5_000,
  nowMs: 6_000,
  timeZone: "UTC",
};
const filters: FilterDocument = EMPTY_FILTER_DOCUMENT;

function createDatabase(): { database: DatabaseSync; sitePk: number } {
  const database = createMigratedDatabase();
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  return { database, sitePk: Number(row.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly visitor: string;
    readonly session: string;
    readonly time: number;
    readonly path: string;
    readonly siteId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'comparison.test')`,
    )
    .run(
      input.id,
      input.siteId ?? SITE_ID,
      sitePk,
      input.visitor,
      input.session,
      input.time,
      input.time,
      input.path,
    );
}

function createEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    DAILY_SALT_SECRET: "comparison-test-secret",
  } as unknown as Env;
}

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function sqliteQueryEvidence(
  database: DatabaseSync,
  sql: string,
  bindings: readonly SQLInputValue[],
) {
  return {
    sqlBytes: new TextEncoder().encode(sql).byteLength,
    bindCount: bindings.length,
    sha256: createHash("sha256").update(sql).digest("hex"),
    indexedAccess: explainQueryPlan(database, { sql, bindings }).filter(
      (line) => line.includes("idx_visits_site_pk_"),
    ),
  };
}

function preparedPagePathFilter(input: {
  readonly preparationWindow: QueryWindow;
  readonly path: string;
  readonly visitId?: string;
  readonly matchId?: string;
  readonly matchSiteId?: string;
  readonly foreignSiteId?: string;
  readonly scope?: FilterScope;
  readonly duplicateMatch?: boolean;
  readonly filters?: FilterDocument;
  readonly matchCount: number;
}): FilterDocument {
  const scope = input.scope ?? "event";
  const matchId = input.matchId ?? input.visitId;
  if (!matchId) throw new Error("comparison_prepared_match_id_missing");
  const filters =
    input.filters ??
    normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: input.path,
        },
      } as RawFilterDocument,
      analyticsFilterRegistry,
    );
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(
      input.preparationWindow.startMs,
      input.preparationWindow.endExclusiveMs,
      input.preparationWindow.timeZone,
      input.preparationWindow.nowMs,
    ),
    filters,
    scopePreference: scope,
  } as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePreference: FilterScopePreference;
  }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("comparison_prepared_scope_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("comparison_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      advancedMatches:
        scope === "event"
          ? {
              visitIds: Array.from(
                { length: input.matchCount },
                (_unused, index) => ({
                  siteId:
                    index === 0 || (input.duplicateMatch && index === 1)
                      ? (input.matchSiteId ?? SITE_ID)
                      : input.foreignSiteId && index === 2
                        ? input.foreignSiteId
                        : SITE_ID,
                  id:
                    index === 0 ||
                    (input.duplicateMatch && index === 1) ||
                    (input.foreignSiteId && index === 2)
                      ? matchId
                      : `unused-${matchId}-${index}`,
                }),
              ),
              eventIds: [],
            }
          : {
              entityIds: Array.from(
                { length: input.matchCount },
                (_unused, index) => ({
                  siteId:
                    index === 0 || (input.duplicateMatch && index === 1)
                      ? (input.matchSiteId ?? SITE_ID)
                      : input.foreignSiteId && index === 2
                        ? input.foreignSiteId
                        : SITE_ID,
                  id:
                    index === 0 ||
                    (input.duplicateMatch && index === 1) ||
                    (input.foreignSiteId && index === 2)
                      ? matchId
                      : `unused-${matchId}-${index}`,
                }),
              ),
            },
    },
  });
}

function pagePathFilter(path: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: path,
      },
    } as unknown as RawFilterDocument,
    analyticsFilterRegistry,
  );
}

function comparisonFortyConditionGlobalFilter(path: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "US",
          },
          {
            kind: "or",
            children: Array.from({ length: 40 }, (_unused, index) => ({
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: index === 0 ? path : `/comparison-global-${index}`,
            })),
          },
        ],
      },
    } as unknown as RawFilterDocument,
    analyticsFilterRegistry,
  );
}

interface FrozenComparisonSide {
  readonly ctes: string;
  readonly relation: string;
  readonly filterClause: string;
  readonly cteBindings: Array<string | number | null>;
  readonly filterBindings: Array<string | number | null>;
}

/** Frozen pre-Wave71 Comparison source assembly, retained only as a SQLite oracle. */
function frozenComparisonSide(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  prefix: string,
): FrozenComparisonSide {
  const dataset = scopedDatasetFor(siteId, window, filters);
  const rename = (value: string) =>
    value
      .replace(/\bscope_[A-Za-z0-9_]*/gu, (name) => `${prefix}_${name}`)
      .replace(/\bvisit_source\b/gu, `${prefix}_visit_source`);
  if (dataset) {
    return {
      ctes: rename(dataset.ctes),
      relation: rename(dataset.visitRelation),
      filterClause: "",
      cteBindings: dataset.bindings.map(({ value }) => value),
      filterBindings: [],
    };
  }
  const relation = `${prefix}_visit_source`;
  const filter = buildVisitFilterSql(filters, relation, { window });
  return {
    ctes: buildVisitSourceCte().replace("visit_source", relation),
    relation,
    filterClause: filter.clause,
    cteBindings: [...visitSourceBindings(siteId, window)],
    filterBindings: [...filter.bindings],
  };
}

function frozenComparisonMap(row: Record<string, unknown>) {
  const number = (name: string) => Number(row[name] ?? 0);
  const currentViews = number("current_views");
  const currentSessions = number("current_sessions");
  const currentVisitors = number("current_visitors");
  const referenceViews = number("reference_views");
  const referenceSessions = number("reference_sessions");
  const referenceVisitors = number("reference_visitors");
  const delta = (a: number, b: number) => ({
    absolute: a - b,
    relative: b === 0 ? (a === 0 ? 0 : null) : (a - b) / b,
  });
  const key = String(row.key ?? "");
  return {
    key,
    value: key,
    views: currentViews,
    sessions: currentSessions,
    visitors: currentVisitors,
    reference: {
      views: referenceViews,
      sessions: referenceSessions,
      visitors: referenceVisitors,
    },
    change: {
      views: delta(currentViews, referenceViews),
      sessions: delta(currentSessions, referenceSessions),
      visitors: delta(currentVisitors, referenceVisitors),
    },
  };
}

function frozenDimensionRows(input: {
  readonly database: DatabaseSync;
  readonly siteId: string;
  readonly current: QueryWindow;
  readonly currentFilters: FilterDocument;
  readonly reference: QueryWindow;
  readonly referenceFilters: FilterDocument;
  readonly selectionSql: string;
  readonly metric?: "views" | "sessions" | "visitors";
  readonly sortBy?: "current" | "reference" | "change";
  readonly direction?: "asc" | "desc";
  readonly search?: string;
}): {
  readonly rows: ReturnType<typeof frozenComparisonMap>[];
  readonly sql: string;
  readonly bindings: Array<string | number | null>;
} {
  const currentSide = frozenComparisonSide(
    input.siteId,
    input.current,
    input.currentFilters,
    "current",
  );
  const referenceSide = frozenComparisonSide(
    input.siteId,
    input.reference,
    input.referenceFilters,
    "reference",
  );
  const normalizedSearch = input.search?.trim().toLowerCase();
  const searchClause = normalizedSearch
    ? "AND LOWER(key) LIKE ? ESCAPE '\\'"
    : "";
  const searchBindings = normalizedSearch
    ? [
        `%${normalizedSearch
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const metric = input.metric ?? "views";
  const sortBy = input.sortBy ?? "current";
  const direction = input.direction ?? "desc";
  const currentColumn = `current_${metric}`;
  const referenceColumn = `reference_${metric}`;
  const primaryColumn =
    sortBy === "reference" ? referenceColumn : currentColumn;
  const secondaryColumn =
    sortBy === "reference" ? currentColumn : referenceColumn;
  const ordering =
    sortBy === "change"
      ? `change_class ${direction}, change_relative ${direction}, key ASC`
      : `${primaryColumn} ${direction}, ${secondaryColumn} ${direction}, key ASC`;
  const sql = `WITH ${currentSide.ctes}, ${referenceSide.ctes},
current_rollup AS (
  SELECT COALESCE(${input.selectionSql}, '') AS key,
    count(*) AS current_views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS current_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS current_visitors
  FROM ${currentSide.relation} ${currentSide.filterClause}
  GROUP BY key
),
reference_rollup AS (
  SELECT COALESCE(${input.selectionSql}, '') AS key,
    count(*) AS reference_views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS reference_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS reference_visitors
  FROM ${referenceSide.relation} ${referenceSide.filterClause}
  GROUP BY key
),
joined AS (
  SELECT keys.key,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors
  FROM (SELECT key FROM current_rollup UNION SELECT key FROM reference_rollup) keys
  LEFT JOIN current_rollup c ON c.key = keys.key
  LEFT JOIN reference_rollup r ON r.key = keys.key
),
projected AS (
  SELECT *,
    CASE WHEN ${referenceColumn} = 0 THEN
      CASE WHEN ${currentColumn} = 0 THEN 0.0 ELSE NULL END
    ELSE (${currentColumn} - ${referenceColumn}) * 1.0 / ${referenceColumn} END AS change_relative,
    CASE WHEN ${referenceColumn} = 0 AND ${currentColumn} > 0 THEN 1 ELSE 0 END AS change_class
  FROM joined
)
SELECT * FROM projected WHERE key != '' ${searchClause}
ORDER BY ${ordering} LIMIT 1000`;
  const bindings = [
    ...currentSide.cteBindings,
    ...referenceSide.cteBindings,
    ...currentSide.filterBindings,
    ...referenceSide.filterBindings,
    ...searchBindings,
  ];
  const rows = input.database.prepare(sql).all(...bindings) as Array<
    Record<string, unknown>
  >;
  return { rows: rows.map(frozenComparisonMap), sql, bindings };
}

function frozenSessionPathRows(input: {
  readonly database: DatabaseSync;
  readonly siteId: string;
  readonly current: QueryWindow;
  readonly currentFilters: FilterDocument;
  readonly reference: QueryWindow;
  readonly referenceFilters: FilterDocument;
  readonly kind: "entry" | "exit";
  readonly metric: "views" | "sessions" | "visitors";
  readonly sortBy: "current" | "reference" | "change";
  readonly direction: "asc" | "desc";
}): {
  readonly rows: ReturnType<typeof frozenComparisonMap>[];
  readonly sql: string;
  readonly bindings: Array<string | number | null>;
} {
  const currentSide = frozenComparisonSide(
    input.siteId,
    input.current,
    input.currentFilters,
    "current",
  );
  const referenceSide = frozenComparisonSide(
    input.siteId,
    input.reference,
    input.referenceFilters,
    "reference",
  );
  const order = input.kind === "entry" ? "ASC" : "DESC";
  const rank = input.kind === "entry" ? "first_rank" : "latest_rank";
  const currentColumn = `current_${input.metric}`;
  const referenceColumn = `reference_${input.metric}`;
  const primaryColumn =
    input.sortBy === "reference" ? referenceColumn : currentColumn;
  const secondaryColumn =
    input.sortBy === "reference" ? currentColumn : referenceColumn;
  const ordering =
    input.sortBy === "change"
      ? `change_class ${input.direction}, change_relative ${input.direction}, key ASC`
      : `${primaryColumn} ${input.direction}, ${secondaryColumn} ${input.direction}, key ASC`;
  const relative = `CASE WHEN ${referenceColumn} = 0 THEN CASE WHEN ${currentColumn} = 0 THEN 0.0 ELSE NULL END ELSE (${currentColumn} - ${referenceColumn}) * 1.0 / ${referenceColumn} END`;
  const changeClass = `CASE WHEN ${referenceColumn} = 0 AND ${currentColumn} > 0 THEN 1 ELSE 0 END`;
  const sql = `WITH ${currentSide.ctes}, ${referenceSide.ctes},
current_ranked AS (
  SELECT session_id, visitor_id, TRIM(COALESCE(pathname, '')) AS pathname,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at ${order}, visit_id ${order}) AS ${rank}
  FROM ${currentSide.relation} ${currentSide.filterClause}
  WHERE session_id != '' AND TRIM(COALESCE(pathname, '')) != ''
),
reference_ranked AS (
  SELECT session_id, visitor_id, TRIM(COALESCE(pathname, '')) AS pathname,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at ${order}, visit_id ${order}) AS ${rank}
  FROM ${referenceSide.relation} ${referenceSide.filterClause}
  WHERE session_id != '' AND TRIM(COALESCE(pathname, '')) != ''
),
current_rollup AS (
  SELECT pathname AS key, count(*) AS current_views, count(*) AS current_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS current_visitors
  FROM current_ranked WHERE ${rank} = 1 GROUP BY pathname
),
reference_rollup AS (
  SELECT pathname AS key, count(*) AS reference_views, count(*) AS reference_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS reference_visitors
  FROM reference_ranked WHERE ${rank} = 1 GROUP BY pathname
),
joined AS (
  SELECT keys.key,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors
  FROM (SELECT key FROM current_rollup UNION SELECT key FROM reference_rollup) keys
  LEFT JOIN current_rollup c ON c.key = keys.key
  LEFT JOIN reference_rollup r ON r.key = keys.key
),
projected AS (
  SELECT *, ${relative} AS change_relative, ${changeClass} AS change_class
  FROM joined
)
SELECT * FROM projected WHERE key != ''
ORDER BY ${ordering} LIMIT 1000`;
  const bindings = [
    ...currentSide.cteBindings,
    ...referenceSide.cteBindings,
    ...currentSide.filterBindings,
    ...referenceSide.filterBindings,
  ];
  const rows = input.database.prepare(sql).all(...bindings) as Array<
    Record<string, unknown>
  >;
  return { rows: rows.map(frozenComparisonMap), sql, bindings };
}

function addDimensionMeasureRows(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly prefix: string;
    readonly path: string;
    readonly startMs: number;
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
  },
): void {
  for (let index = 0; index < input.views; index++) {
    addVisit(database, sitePk, {
      id: `${input.prefix}-${index}`,
      visitor: `${input.prefix}-visitor-${index % input.visitors}`,
      session: `${input.prefix}-session-${index % input.sessions}`,
      time: input.startMs + index,
      path: input.path,
    });
  }
}

function addSessionPathRows(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly prefix: string;
    readonly path: string;
    readonly startMs: number;
    readonly sessions: number;
    readonly visitors: number;
  },
): void {
  for (let index = 0; index < input.sessions; index++) {
    addVisit(database, sitePk, {
      id: `${input.prefix}-${index}`,
      visitor: `${input.prefix}-visitor-${index % input.visitors}`,
      session: `${input.prefix}-session-${index}`,
      time: input.startMs + index,
      path: input.path,
    });
  }
}

const COMPARISON_SORT_CASES = (
  ["views", "sessions", "visitors"] as const
).flatMap((metric) =>
  (["current", "reference", "change"] as const).flatMap((sortBy) =>
    (["asc", "desc"] as const).map((direction) => ({
      metric,
      sortBy,
      direction,
    })),
  ),
);
const SESSION_COMPARISON_SORT_CASES = (["entry", "exit"] as const).flatMap(
  (kind) => COMPARISON_SORT_CASES.map((sortCase) => ({ kind, ...sortCase })),
);

describe("comparison dimension readers", () => {
  it("composes current and reference dimension rollups in one query and pages with a signed cursor", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "c-a-1",
        visitor: "v-a",
        session: "s-a",
        time: 1_100,
        path: "/a",
      });
      addVisit(database, sitePk, {
        id: "c-a-2",
        visitor: "v-a",
        session: "s-a",
        time: 1_200,
        path: "/a",
      });
      addVisit(database, sitePk, {
        id: "c-b",
        visitor: "v-b",
        session: "s-b",
        time: 1_300,
        path: "/b",
      });
      addVisit(database, sitePk, {
        id: "r-a",
        visitor: "rv-a",
        session: "rs-a",
        time: 4_100,
        path: "/a",
      });
      addVisit(database, sitePk, {
        id: "r-a-2",
        visitor: "rv-a-2",
        session: "rs-a-2",
        time: 4_150,
        path: "/a",
      });
      addVisit(database, sitePk, {
        id: "r-a-3",
        visitor: "rv-a-3",
        session: "rs-a-3",
        time: 4_175,
        path: "/a",
      });
      addVisit(database, sitePk, {
        id: "r-c",
        visitor: "rv-c",
        session: "rs-c",
        time: 4_200,
        path: "/c",
      });
      addVisit(database, sitePk, {
        id: "c-empty-key",
        visitor: "",
        session: "",
        time: 1_500,
        path: "",
      });
      addVisit(database, sitePk, {
        id: "c-empty-ids",
        visitor: "",
        session: "",
        time: 1_600,
        path: "/id-empty",
      });
      addVisit(database, sitePk, {
        id: "c-search-literal",
        visitor: "v-search",
        session: "s-search",
        time: 1_700,
        path: "/a%_\\Tag",
      });
      addVisit(database, sitePk, {
        id: "c-search-wildcard",
        visitor: "v-wildcard",
        session: "s-wildcard",
        time: 1_750,
        path: "/zXX\\Tag",
      });
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run("comparison-foreign-site");
      const foreignPk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get("comparison-foreign-site") as { readonly site_pk: number }
        ).site_pk,
      );
      addVisit(database, foreignPk, {
        id: "foreign-a",
        visitor: "foreign-visitor",
        session: "foreign-session",
        time: 1_700,
        path: "/a",
        siteId: "comparison-foreign-site",
      });

      const queryTrace = trace();
      const env = createEnv(database, queryTrace);
      const oracle = frozenDimensionRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: filters,
        reference,
        referenceFilters: filters,
        selectionSql: "TRIM(COALESCE(pathname, ''))",
      });
      const page = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        null,
        "private-dashboard",
      );

      expect(page.items).toEqual([
        expect.objectContaining({
          key: "/a",
          views: 2,
          sessions: 1,
          visitors: 1,
          reference: { views: 3, sessions: 3, visitors: 3 },
          change: expect.objectContaining({
            views: { absolute: -1, relative: -1 / 3 },
          }),
        }),
      ]);
      expect(page.items).toEqual(oracle.rows.slice(0, 1));
      expect(page.pagination).toMatchObject({
        limit: 1,
        returned: 1,
        hasMore: true,
      });
      expect(page.pagination.nextCursor).toEqual(expect.any(String));
      expect(queryTrace.preparedSql).toHaveLength(1);
      console.info(
        "wave71_default_dimension_comparison_evidence",
        JSON.stringify({
          legacy: sqliteQueryEvidence(database, oracle.sql, oracle.bindings),
          logical: sqliteQueryEvidence(
            database,
            queryTrace.preparedSql[0]!,
            queryTrace.bindings[0]!,
          ),
        }),
      );
      expect(queryTrace.preparedSql[0]).not.toContain("TRIM(COALESCE(pathname");

      const cursor = await decodeComparisonDimensionCursor(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        "TRIM(COALESCE(pathname, ''))",
        undefined,
        page.pagination.nextCursor,
        "private-dashboard",
        "views",
        "current",
        "desc",
      );
      expect(cursor).toEqual({
        sortClass: 0,
        primary: 2,
        secondary: 3,
        key: "/a",
      });

      const nextPage = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        cursor,
        "private-dashboard",
      );
      expect(nextPage.items[0]?.key).toBe("/a%_\\Tag");
      const afterSearchKey = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        await decodeComparisonDimensionCursor(
          env,
          SITE_ID,
          current,
          filters,
          reference,
          filters,
          "TRIM(COALESCE(pathname, ''))",
          undefined,
          nextPage.pagination.nextCursor,
          "private-dashboard",
          "views",
          "current",
          "desc",
        ),
        "private-dashboard",
      );
      expect(afterSearchKey.items[0]?.key).toBe("/b");
      const afterEmptyIds = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        await decodeComparisonDimensionCursor(
          env,
          SITE_ID,
          current,
          filters,
          reference,
          filters,
          "TRIM(COALESCE(pathname, ''))",
          undefined,
          afterSearchKey.pagination.nextCursor,
          "private-dashboard",
          "views",
          "current",
          "desc",
        ),
        "private-dashboard",
      );
      expect(afterEmptyIds.items[0]).toMatchObject({
        key: "/id-empty",
        sessions: 0,
        visitors: 0,
      });
      const search = "%_\\T";
      const searchOracle = frozenDimensionRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: filters,
        reference,
        referenceFilters: filters,
        selectionSql: "TRIM(COALESCE(pathname, ''))",
        search,
      });
      const searched = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        10,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          search,
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        null,
        "private-dashboard",
      );
      expect(searched.items).toEqual(searchOracle.rows);
      expect(searched.items.map((row) => row.key)).toEqual(["/a%_\\Tag"]);
      expect(queryTrace.preparedSql).toHaveLength(5);
    } finally {
      database.close();
    }
  });

  it("preserves SEM066 null-relative cursor behavior for current-only change rows", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "c-a",
        visitor: "v-a",
        session: "s-a",
        time: 1_100,
        path: "/fresh-a",
      });
      addVisit(database, sitePk, {
        id: "c-b",
        visitor: "v-b",
        session: "s-b",
        time: 1_200,
        path: "/fresh-b",
      });
      const env = createEnv(database, trace());
      const firstPage = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "change",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        null,
        "private-dashboard",
      );

      expect(firstPage.items[0]?.change.views.relative).toBeNull();
      expect(firstPage.pagination.hasMore).toBe(true);
      const cursor = await decodeComparisonDimensionCursor(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        "TRIM(COALESCE(pathname, ''))",
        undefined,
        firstPage.pagination.nextCursor,
        "private-dashboard",
        "views",
        "change",
        "desc",
      );
      expect(cursor).toMatchObject({ sortClass: 1, primary: 0 });

      const continuation = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        1,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "change",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        cursor,
        "private-dashboard",
      );
      expect(continuation.items).toEqual([]);
      expect(continuation.pagination.hasMore).toBe(false);
    } finally {
      database.close();
    }
  });

  it.each(COMPARISON_SORT_CASES)(
    "matches frozen DTO order and real cursor pages for dimension %o",
    async ({ metric, sortBy, direction }) => {
      const { database, sitePk } = createDatabase();
      try {
        const groups = [
          {
            key: "a",
            current: { views: 4, sessions: 2, visitors: 1 },
            reference: { views: 3, sessions: 1, visitors: 1 },
          },
          {
            key: "b",
            current: { views: 4, sessions: 1, visitors: 2 },
            reference: { views: 3, sessions: 2, visitors: 1 },
          },
          {
            key: "c",
            current: { views: 2, sessions: 2, visitors: 2 },
            reference: { views: 4, sessions: 1, visitors: 2 },
          },
          {
            key: "d",
            current: { views: 1, sessions: 1, visitors: 1 },
            reference: { views: 1, sessions: 1, visitors: 1 },
          },
        ] as const;
        for (const [index, group] of groups.entries()) {
          addDimensionMeasureRows(database, sitePk, {
            prefix: `current-${group.key}`,
            path: `/${group.key}`,
            startMs: 1_100 + index * 20,
            ...group.current,
          });
          addDimensionMeasureRows(database, sitePk, {
            prefix: `reference-${group.key}`,
            path: `/${group.key}`,
            startMs: 4_100 + index * 20,
            ...group.reference,
          });
        }
        const queryTrace = trace();
        const env = createEnv(database, queryTrace);
        const oracle = frozenDimensionRows({
          database,
          siteId: SITE_ID,
          current,
          currentFilters: filters,
          reference,
          referenceFilters: filters,
          selectionSql: "TRIM(COALESCE(pathname, ''))",
          metric,
          sortBy,
          direction,
        });
        const rows = [];
        let cursor: Awaited<
          ReturnType<typeof decodeComparisonDimensionCursor>
        > = null;
        let pageCount = 0;
        while (pageCount < 3) {
          const page = await queryComparisonDimensionPageFromD1(
            env,
            SITE_ID,
            current,
            filters,
            reference,
            filters,
            2,
            "TRIM(COALESCE(pathname, ''))",
            {
              metric,
              sortBy,
              direction,
              selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
            },
            cursor,
            "private-dashboard",
          );
          rows.push(...page.items);
          pageCount++;
          if (!page.pagination.hasMore) {
            expect(page.pagination.nextCursor).toBeNull();
            break;
          }
          expect(page.pagination.nextCursor).toEqual(expect.any(String));
          cursor = await decodeComparisonDimensionCursor(
            env,
            SITE_ID,
            current,
            filters,
            reference,
            filters,
            "TRIM(COALESCE(pathname, ''))",
            undefined,
            page.pagination.nextCursor,
            "private-dashboard",
            metric,
            sortBy,
            direction,
          );
          expect(cursor).not.toBeNull();
        }

        expect(pageCount).toBe(2);
        expect(rows).toEqual(oracle.rows);
        expect(queryTrace.preparedSql).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  );

  it("keeps prepared filters independent, reader windows actual, and the production D1 budgets", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "prepared-current",
        visitor: "v-current",
        session: "s-current",
        time: 1_500,
        path: "/current-prepared",
      });
      addVisit(database, sitePk, {
        id: "prepared-reference",
        visitor: "v-reference",
        session: "s-reference",
        time: 4_500,
        path: "/reference-prepared",
      });
      const currentPrepared = preparedPagePathFilter({
        preparationWindow: {
          startMs: 0,
          endExclusiveMs: 500,
          nowMs: 800,
          timeZone: "UTC",
        },
        path: "/current-prepared",
        visitId: "prepared-current",
        matchCount: 128,
      });
      const referencePrepared = preparedPagePathFilter({
        preparationWindow: {
          startMs: 2_500,
          endExclusiveMs: 3_500,
          nowMs: 3_800,
          timeZone: "UTC",
        },
        path: "/reference-prepared",
        visitId: "prepared-reference",
        matchCount: 128,
      });
      const queryTrace = trace();
      const env = createEnv(database, queryTrace);
      const oracle = frozenDimensionRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: currentPrepared,
        reference,
        referenceFilters: referencePrepared,
        selectionSql: "TRIM(COALESCE(pathname, ''))",
      });
      const page = await queryComparisonDimensionPageFromD1(
        env,
        SITE_ID,
        current,
        currentPrepared,
        reference,
        referencePrepared,
        10,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        null,
        "private-dashboard",
      );

      expect(page.items).toEqual(oracle.rows);
      expect(page.items.map((row) => row.key)).toEqual([
        "/current-prepared",
        "/reference-prepared",
      ]);
      expect(queryTrace.preparedSql).toHaveLength(1);
      const sql = queryTrace.preparedSql[0]!;
      const bindings = queryTrace.bindings[0]!;
      const sqlBytes = new TextEncoder().encode(sql).byteLength;
      const hash = createHash("sha256").update(sql).digest("hex");
      const plan = explainQueryPlan(database, { sql, bindings });
      const legacyPlan = explainQueryPlan(database, {
        sql: oracle.sql,
        bindings: oracle.bindings,
      });
      const legacySqlBytes = new TextEncoder().encode(oracle.sql).byteLength;
      const legacyHash = createHash("sha256").update(oracle.sql).digest("hex");
      expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(bindings.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(plan.join("\n")).toMatch(/SEARCH .*visits/iu);
      expect(legacySqlBytes).toBeGreaterThan(sqlBytes);
      expect(oracle.bindings.length).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);
      expect(legacyHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(legacyPlan.join("\n")).toMatch(
        /SEARCH visits USING INDEX idx_visits_site_pk_started_at/iu,
      );
    } finally {
      database.close();
    }
  });

  it.each(["event", "session", "visitor"] as const)(
    "preserves prepared %s scope matches across both comparison readers",
    async (scope) => {
      const { database, sitePk } = createDatabase();
      const foreignSiteId = `${SITE_ID}-foreign-scope`;
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(foreignSiteId);
      const foreignPk = Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(foreignSiteId) as { readonly site_pk: number }
        ).site_pk,
      );
      try {
        addVisit(database, sitePk, {
          id: "prepared-current-before-window",
          visitor: "prepared-current-visitor",
          session: "prepared-current-session",
          time: 950,
          path: "/current-before-window",
        });
        addVisit(database, sitePk, {
          id: "prepared-current-selected",
          visitor: "prepared-current-visitor",
          session: "prepared-current-session",
          time: 1_200,
          path: "/current-selected",
        });
        addVisit(database, sitePk, {
          id: "prepared-current-expanded",
          visitor: "prepared-current-visitor",
          session: "prepared-current-session",
          time: 1_500,
          path: "/current-expanded",
        });
        addVisit(database, sitePk, {
          id: "prepared-current-after-metadata",
          visitor: "prepared-current-visitor",
          session: "prepared-current-session",
          time: 1_900,
          path: "/current-after-metadata",
        });
        addVisit(database, sitePk, {
          id: "prepared-current-decoy",
          visitor: "prepared-current-decoy",
          session: "prepared-current-decoy",
          time: 1_700,
          path: "/current-decoy",
        });
        addVisit(database, sitePk, {
          id: "prepared-reference-before-window",
          visitor: "prepared-reference-visitor",
          session: "prepared-reference-session",
          time: 3_950,
          path: "/reference-before-window",
        });
        addVisit(database, sitePk, {
          id: "prepared-reference-selected",
          visitor: "prepared-reference-visitor",
          session: "prepared-reference-session",
          time: 4_200,
          path: "/reference-selected",
        });
        addVisit(database, sitePk, {
          id: "prepared-reference-after-metadata",
          visitor: "prepared-reference-visitor",
          session: "prepared-reference-session",
          time: 4_900,
          path: "/reference-after-metadata",
        });
        addVisit(database, sitePk, {
          id: "prepared-reference-expanded",
          visitor: "prepared-reference-visitor",
          session: "prepared-reference-session",
          time: 4_600,
          path: "/reference-expanded",
        });
        addVisit(database, foreignPk, {
          id: "prepared-foreign-current",
          visitor: "prepared-current-visitor",
          session: "prepared-current-session",
          time: 1_800,
          path: "/foreign-site",
          siteId: foreignSiteId,
        });

        const matchId = (period: "current" | "reference") =>
          scope === "event"
            ? `prepared-${period}-selected`
            : scope === "session"
              ? `prepared-${period}-session`
              : `prepared-${period}-visitor`;
        const currentPrepared = preparedPagePathFilter({
          scope,
          preparationWindow: {
            startMs: 900,
            endExclusiveMs: 1_800,
            nowMs: 2_500,
            timeZone: "America/New_York",
          },
          path: "/current-selected",
          matchId: matchId("current"),
          duplicateMatch: true,
          matchCount: 128,
        });
        const referencePrepared = preparedPagePathFilter({
          scope,
          preparationWindow: {
            startMs: 3_900,
            endExclusiveMs: 4_800,
            nowMs: 7_500,
            timeZone: "Europe/Paris",
          },
          path: "/reference-selected",
          matchId: matchId("reference"),
          duplicateMatch: true,
          matchCount: 128,
        });

        expect(scopedFilterMetadata(currentPrepared)?.time).toMatchObject({
          range: { startMs: 900, endExclusiveMs: 1_800 },
          reportingTimeZone: "America/New_York",
          capturedAtMs: 2_500,
        });
        expect(scopedFilterMetadata(referencePrepared)?.time).toMatchObject({
          range: { startMs: 3_900, endExclusiveMs: 4_800 },
          reportingTimeZone: "Europe/Paris",
          capturedAtMs: 7_500,
        });

        const dimensionOracle = frozenDimensionRows({
          database,
          siteId: SITE_ID,
          current,
          currentFilters: currentPrepared,
          reference,
          referenceFilters: referencePrepared,
          selectionSql: "TRIM(COALESCE(pathname, ''))",
          metric: "views",
          sortBy: "current",
          direction: "desc",
        });
        const dimensionTrace = trace();
        const dimensionPage = await queryComparisonDimensionPageFromD1(
          createEnv(database, dimensionTrace),
          SITE_ID,
          current,
          currentPrepared,
          reference,
          referencePrepared,
          20,
          "TRIM(COALESCE(pathname, ''))",
          {
            metric: "views",
            sortBy: "current",
            direction: "desc",
            selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
          },
          null,
          "private-dashboard",
        );
        expect(dimensionPage.items).toEqual(dimensionOracle.rows);
        expect(dimensionTrace.preparedSql).toHaveLength(1);
        expect(dimensionTrace.bindings[0]!.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(
          new TextEncoder().encode(dimensionTrace.preparedSql[0]!).byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(dimensionOracle.bindings.length).toBeGreaterThan(
          D1_MAX_BOUND_PARAMETERS,
        );
        console.info(
          "wave71_prepared_comparison_evidence",
          JSON.stringify({
            scope,
            dimension: {
              legacy: sqliteQueryEvidence(
                database,
                dimensionOracle.sql,
                dimensionOracle.bindings,
              ),
              logical: sqliteQueryEvidence(
                database,
                dimensionTrace.preparedSql[0]!,
                dimensionTrace.bindings[0]!,
              ),
            },
          }),
        );
        expect(
          explainQueryPlan(database, {
            sql: dimensionTrace.preparedSql[0]!,
            bindings: dimensionTrace.bindings[0]!,
          }).join("\n"),
        ).toMatch(
          /SEARCH .* USING INDEX idx_visits_site_pk_(?:started_at|session_started_at|visitor_started_at)/iu,
        );
        const currentKeys = dimensionPage.items.map((row) => row.key);
        expect(currentKeys).not.toContain("/foreign-site");
        expect(currentKeys).not.toContain("/current-decoy");
        expect(currentKeys).not.toContain("/current-before-window");
        expect(currentKeys).not.toContain("/reference-before-window");
        expect(currentKeys).toContain("/current-selected");
        if (scope === "event")
          expect(currentKeys).not.toContain("/current-expanded");
        else {
          expect(currentKeys).toContain("/current-expanded");
          expect(currentKeys).toContain("/current-after-metadata");
          expect(currentKeys).toContain("/reference-after-metadata");
        }

        const sessionOracle = frozenSessionPathRows({
          database,
          siteId: SITE_ID,
          current,
          currentFilters: currentPrepared,
          reference,
          referenceFilters: referencePrepared,
          kind: "exit",
          metric: "sessions",
          sortBy: "current",
          direction: "desc",
        });
        const sessionTrace = trace();
        const sessionPage = await queryComparisonSessionPathPageFromD1(
          createEnv(database, sessionTrace),
          SITE_ID,
          current,
          currentPrepared,
          reference,
          referencePrepared,
          20,
          "exit",
          { metric: "sessions", sortBy: "current", direction: "desc" },
          null,
          "private-dashboard",
        );
        expect(sessionPage.items).toEqual(sessionOracle.rows);
        expect(sessionTrace.preparedSql).toHaveLength(1);
        expect(sessionTrace.bindings[0]!.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        expect(
          new TextEncoder().encode(sessionTrace.preparedSql[0]!).byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(sessionOracle.bindings.length).toBeGreaterThan(
          D1_MAX_BOUND_PARAMETERS,
        );
        console.info(
          "wave71_prepared_comparison_session_path_evidence",
          JSON.stringify({
            scope,
            legacy: sqliteQueryEvidence(
              database,
              sessionOracle.sql,
              sessionOracle.bindings,
            ),
            logical: sqliteQueryEvidence(
              database,
              sessionTrace.preparedSql[0]!,
              sessionTrace.bindings[0]!,
            ),
          }),
        );
        expect(
          explainQueryPlan(database, {
            sql: sessionTrace.preparedSql[0]!,
            bindings: sessionTrace.bindings[0]!,
          }).join("\n"),
        ).toMatch(
          /SEARCH .* USING INDEX idx_visits_site_pk_(?:started_at|session_started_at|visitor_started_at)/iu,
        );
        expect(sessionPage.items.map((row) => row.key)).toContain(
          scope === "event" ? "/current-selected" : "/current-after-metadata",
        );
      } finally {
        database.close();
      }
    },
  );

  it("measures forty distinct legal conditions with a global filter before comparison migration", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "forty-current",
        visitor: "forty-current-visitor",
        session: "forty-current-session",
        time: 1_500,
        path: "/current-global-match",
      });
      addVisit(database, sitePk, {
        id: "forty-reference",
        visitor: "forty-reference-visitor",
        session: "forty-reference-session",
        time: 4_500,
        path: "/reference-global-match",
      });
      addVisit(database, sitePk, {
        id: "forty-global-excluded",
        visitor: "forty-global-excluded-visitor",
        session: "forty-global-excluded-session",
        time: 1_600,
        path: "/current-global-match",
      });
      database
        .prepare("UPDATE visits SET country = 'US' WHERE visit_id IN (?, ?)")
        .run("forty-current", "forty-reference");

      const currentConditions = comparisonFortyConditionGlobalFilter(
        "/current-global-match",
      );
      const referenceConditions = comparisonFortyConditionGlobalFilter(
        "/reference-global-match",
      );
      const oracle = frozenDimensionRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: currentConditions,
        reference,
        referenceFilters: referenceConditions,
        selectionSql: "TRIM(COALESCE(pathname, ''))",
        metric: "views",
        sortBy: "current",
        direction: "desc",
      });
      const queryTrace = trace();
      const page = await queryComparisonDimensionPageFromD1(
        createEnv(database, queryTrace),
        SITE_ID,
        current,
        currentConditions,
        reference,
        referenceConditions,
        20,
        "TRIM(COALESCE(pathname, ''))",
        {
          metric: "views",
          sortBy: "current",
          direction: "desc",
          selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
        },
        null,
        "private-dashboard",
      );
      expect(page.items).toEqual(oracle.rows);
      expect(page.items.map((row) => row.key)).toEqual([
        "/current-global-match",
        "/reference-global-match",
      ]);
      expect(queryTrace.preparedSql).toHaveLength(1);
      const productionSql = queryTrace.preparedSql[0]!;
      const productionBindings = queryTrace.bindings[0]!;
      const productionBytes = new TextEncoder().encode(
        productionSql,
      ).byteLength;
      expect(productionBindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(productionBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(oracle.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        new TextEncoder().encode(oracle.sql).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(
        explainQueryPlan(database, {
          sql: productionSql,
          bindings: productionBindings,
        }).join("\n"),
      ).toMatch(
        /SEARCH .* USING INDEX idx_visits_site_pk_(?:started_at|session_started_at|visitor_started_at)/iu,
      );

      const sessionTrace = trace();
      const sessionPage = await queryComparisonSessionPathPageFromD1(
        createEnv(database, sessionTrace),
        SITE_ID,
        current,
        currentConditions,
        reference,
        referenceConditions,
        20,
        "exit",
        { metric: "sessions", sortBy: "current", direction: "desc" },
        null,
        "private-dashboard",
      );
      expect(sessionPage.items.map((row) => row.key)).toContain(
        "/current-global-match",
      );
      expect(sessionTrace.preparedSql).toHaveLength(1);
      expect(sessionTrace.bindings[0]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        new TextEncoder().encode(sessionTrace.preparedSql[0]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      console.info(
        "wave71_forty_condition_comparison_evidence",
        JSON.stringify({
          legacyDimension: sqliteQueryEvidence(
            database,
            oracle.sql,
            oracle.bindings,
          ),
          logicalDimension: sqliteQueryEvidence(
            database,
            productionSql,
            productionBindings,
          ),
          logicalSessionPath: sqliteQueryEvidence(
            database,
            sessionTrace.preparedSql[0]!,
            sessionTrace.bindings[0]!,
          ),
        }),
      );
    } finally {
      database.close();
    }
  });

  it("keeps the old nonempty SessionPath SQL failure explicit while applying its filter in Logical", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "current-match",
        visitor: "v-current",
        session: "s-current",
        time: 1_500,
        path: "/include",
      });
      addVisit(database, sitePk, {
        id: "current-other",
        visitor: "v-current-other",
        session: "s-current-other",
        time: 1_600,
        path: "/exclude",
      });
      addVisit(database, sitePk, {
        id: "reference-match",
        visitor: "v-reference",
        session: "s-reference",
        time: 4_500,
        path: "/include",
      });
      addVisit(database, sitePk, {
        id: "reference-other",
        visitor: "v-reference-other",
        session: "s-reference-other",
        time: 4_600,
        path: "/exclude",
      });
      const filters = pagePathFilter("/include");
      expect(() =>
        frozenSessionPathRows({
          database,
          siteId: SITE_ID,
          current,
          currentFilters: filters,
          reference,
          referenceFilters: filters,
          kind: "entry",
          metric: "views",
          sortBy: "current",
          direction: "desc",
        }),
      ).toThrow();

      const queryTrace = trace();
      const page = await queryComparisonSessionPathPageFromD1(
        createEnv(database, queryTrace),
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        10,
        "entry",
        { metric: "views", sortBy: "current", direction: "desc" },
        null,
        "private-dashboard",
      );
      expect(page.items).toEqual([
        expect.objectContaining({
          key: "/include",
          views: 1,
          reference: { views: 1, sessions: 1, visitors: 1 },
        }),
      ]);
      expect(queryTrace.preparedSql).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each(SESSION_COMPARISON_SORT_CASES)(
    "matches frozen DTO order and real cursor pages for SessionPath %o",
    async ({ kind, metric, sortBy, direction }) => {
      const { database, sitePk } = createDatabase();
      try {
        const groups = [
          {
            key: "a",
            current: { sessions: 4, visitors: 2 },
            reference: { sessions: 3, visitors: 1 },
          },
          {
            key: "b",
            current: { sessions: 3, visitors: 2 },
            reference: { sessions: 4, visitors: 2 },
          },
          {
            key: "c",
            current: { sessions: 2, visitors: 1 },
            reference: { sessions: 2, visitors: 2 },
          },
          {
            key: "d",
            current: { sessions: 1, visitors: 1 },
            reference: { sessions: 1, visitors: 1 },
          },
        ] as const;
        for (const [index, group] of groups.entries()) {
          addSessionPathRows(database, sitePk, {
            prefix: `current-${group.key}`,
            path: `/${group.key}`,
            startMs: 1_100 + index * 20,
            ...group.current,
          });
          addSessionPathRows(database, sitePk, {
            prefix: `reference-${group.key}`,
            path: `/${group.key}`,
            startMs: 4_100 + index * 20,
            ...group.reference,
          });
        }
        const queryTrace = trace();
        const env = createEnv(database, queryTrace);
        const oracle = frozenSessionPathRows({
          database,
          siteId: SITE_ID,
          current,
          currentFilters: filters,
          reference,
          referenceFilters: filters,
          kind,
          metric,
          sortBy,
          direction,
        });
        const rows = [];
        let cursor: Awaited<
          ReturnType<typeof decodeComparisonDimensionCursor>
        > = null;
        let pageCount = 0;
        while (pageCount < 3) {
          const page = await queryComparisonSessionPathPageFromD1(
            env,
            SITE_ID,
            current,
            filters,
            reference,
            filters,
            2,
            kind,
            { metric, sortBy, direction },
            cursor,
            "private-dashboard",
          );
          rows.push(...page.items);
          pageCount++;
          if (!page.pagination.hasMore) {
            expect(page.pagination.nextCursor).toBeNull();
            break;
          }
          expect(page.pagination.nextCursor).toEqual(expect.any(String));
          cursor = await decodeComparisonDimensionCursor(
            env,
            SITE_ID,
            current,
            filters,
            reference,
            filters,
            `session.${kind}`,
            undefined,
            page.pagination.nextCursor,
            "private-dashboard",
            metric,
            sortBy,
            direction,
          );
          expect(cursor).not.toBeNull();
        }

        expect(pageCount).toBe(2);
        expect(rows).toEqual(oracle.rows);
        expect(queryTrace.preparedSql).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  );

  it("composes entry and exit session-path rollups with each period's own window", async () => {
    const { database, sitePk } = createDatabase();
    try {
      addVisit(database, sitePk, {
        id: "c-s1-blank",
        visitor: "",
        session: "c-s1",
        time: 1_050,
        path: " ",
      });
      addVisit(database, sitePk, {
        id: "a-c-s1-first",
        visitor: "v-c-shared",
        session: "c-s1",
        time: 1_100,
        path: "/start",
      });
      addVisit(database, sitePk, {
        id: "z-c-s1-first-tie",
        visitor: "v-c-shared",
        session: "c-s1",
        time: 1_100,
        path: "/tie-first",
      });
      addVisit(database, sitePk, {
        id: "z-c-s1-last",
        visitor: "v-c-exit1",
        session: "c-s1",
        time: 1_200,
        path: "/finish",
      });
      addVisit(database, sitePk, {
        id: "a-c-s1-last-tie",
        visitor: "v-c-exit1",
        session: "c-s1",
        time: 1_200,
        path: "/tie-last",
      });
      addVisit(database, sitePk, {
        id: "c-s2-first",
        visitor: "v-c-shared",
        session: "c-s2",
        time: 1_300,
        path: "/start",
      });
      addVisit(database, sitePk, {
        id: "c-s2-last",
        visitor: "v-c-exit2",
        session: "c-s2",
        time: 1_400,
        path: "/finish",
      });
      addVisit(database, sitePk, {
        id: "c-s3-empty-visitor",
        visitor: "",
        session: "c-s3",
        time: 1_450,
        path: "/start",
      });
      addVisit(database, sitePk, {
        id: "c-empty-session",
        visitor: "v-ignored",
        session: "",
        time: 1_475,
        path: "/ignored-session",
      });
      addVisit(database, sitePk, {
        id: "r-s1-first",
        visitor: "v-r1",
        session: "r-s1",
        time: 4_100,
        path: "/start",
      });
      addVisit(database, sitePk, {
        id: "r-s1-last",
        visitor: "v-r1",
        session: "r-s1",
        time: 4_200,
        path: "/finish",
      });
      addVisit(database, sitePk, {
        id: "r-s2",
        visitor: "v-r2",
        session: "r-s2",
        time: 4_300,
        path: "/reference-only",
      });

      const queryTrace = trace();
      const env = createEnv(database, queryTrace);
      const entryOracle = frozenSessionPathRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: filters,
        reference,
        referenceFilters: filters,
        kind: "entry",
        metric: "sessions",
        sortBy: "current",
        direction: "desc",
      });
      const exitOracle = frozenSessionPathRows({
        database,
        siteId: SITE_ID,
        current,
        currentFilters: filters,
        reference,
        referenceFilters: filters,
        kind: "exit",
        metric: "sessions",
        sortBy: "reference",
        direction: "desc",
      });
      const entry = await queryComparisonSessionPathPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        10,
        "entry",
        { metric: "sessions", sortBy: "current", direction: "desc" },
        null,
        "private-dashboard",
      );
      const exit = await queryComparisonSessionPathPageFromD1(
        env,
        SITE_ID,
        current,
        filters,
        reference,
        filters,
        10,
        "exit",
        { metric: "sessions", sortBy: "reference", direction: "desc" },
        null,
        "private-dashboard",
      );

      expect(entry.items).toEqual(entryOracle.rows);
      expect(exit.items).toEqual(exitOracle.rows);
      expect(entry.items.find((row) => row.key === "/start")).toMatchObject({
        sessions: 3,
        visitors: 1,
        reference: { sessions: 1, visitors: 1 },
      });
      expect(exit.items.find((row) => row.key === "/finish")).toMatchObject({
        sessions: 2,
        visitors: 2,
        reference: { sessions: 1, visitors: 1 },
      });
      expect(exit.items.some((row) => row.key === "/reference-only")).toBe(
        true,
      );
      expect(entry.items.some((row) => row.key === "/tie-first")).toBe(false);
      expect(exit.items.some((row) => row.key === "/tie-last")).toBe(false);
      expect(exit.items.some((row) => row.key === "/ignored-session")).toBe(
        false,
      );
      expect(queryTrace.preparedSql).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
