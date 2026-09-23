import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type PagesDashboardComparisonQuery,
  type PagesDashboardMetric,
  type PagesDashboardSortBy,
  type QueryAudience,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  DimensionRow,
  FilterDocument,
  Interval,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  PageRow,
  QueryWindow,
  ReferrerRow,
  ReferrerSummaryRow,
} from "./core";
import {
  appendSqlConditions,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  emptyOverviewAggregateRow,
  mapPageCardMetrics,
  normalizePathname,
  percentChange,
  queryD1All,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  queryPageTabsFromD1,
  queryReferrersFromD1,
  queryVisitDimensionFromD1,
} from "./dimensions";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";
import {
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
} from "./scoped-dataset";

export interface PageAggregateCursor {
  readonly views: number;
  readonly sessions: number;
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
}

export interface ReferrerAggregateCursor {
  /** The first two values are the concrete ORDER BY metrics. */
  readonly primary: number;
  readonly secondary: number;
  readonly referrer: string;
}

export type ReferrerPageSortKey = "views" | "visitors";

function pageAggregateCursor(value: unknown): PageAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "views",
    "sessions",
    "pathname",
    "query",
    "hash",
  ]) &&
    typeof candidate.views === "number" &&
    Number.isFinite(candidate.views) &&
    typeof candidate.sessions === "number" &&
    Number.isFinite(candidate.sessions) &&
    typeof candidate.pathname === "string" &&
    typeof candidate.query === "string" &&
    typeof candidate.hash === "string"
    ? (candidate as unknown as PageAggregateCursor)
    : null;
}

function referrerAggregateCursor(
  value: unknown,
): ReferrerAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["primary", "secondary", "referrer"]) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.referrer === "string"
    ? (candidate as unknown as ReferrerAggregateCursor)
    : null;
}

function pageCursorBinding(
  operation: string,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  extra: readonly unknown[] = [],
  audience: QueryAudience = "private-dashboard",
): Promise<string> {
  return paginationBindingForWindow(window, [
    `analytics-${operation}-v1`,
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    effectiveScopeForPagination(filters),
    ...extra,
  ]);
}

export async function queryTopPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: FilterDocument,
): Promise<PageRow[]> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
)
SELECT
  pathname,
  ${queryExpr} AS queryValue,
  ${hashExpr} AS hashValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY pathname, queryValue, hashValue
ORDER BY views DESC, pathname ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      limit,
    ])
  ).map((row) => ({
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

export async function queryPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryTopPagesFromD1(
    env,
    siteId,
    window,
    limit,
    includeDetails,
    filters,
  );
}

export async function queryPagesAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryPagesFromD1(env, siteId, window, filters, limit, includeDetails);
}

/** Keyset-paginated page aggregate. The legacy aggregate reader above remains
 * intentionally bounded for cards, reports, and other Top-N consumers. */
export async function queryPagesPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
  cursor?: PageAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageResult<PageRow>> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const cursorClause = cursor
    ? `
WHERE views < ?
   OR (views = ? AND sessions < ?)
   OR (views = ? AND sessions = ? AND pathname > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue = ? AND hashValue > ?)`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
rollup AS (
  SELECT
    pathname,
    ${queryExpr} AS queryValue,
    ${hashExpr} AS hashValue,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
  FROM filtered_visits
  GROUP BY pathname, queryValue, hashValue
)
SELECT pathname, queryValue, hashValue, views, sessions
FROM rollup
${cursorClause}
ORDER BY views DESC, sessions DESC, pathname ASC, queryValue ASC, hashValue ASC
LIMIT ?
`;
  const cursorBindings = cursor
    ? [
        cursor.views,
        cursor.views,
        cursor.sessions,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.hash,
      ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])]),
    ...cursorBindings,
    limit + 1,
  ]);
  const mapped = rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await pageCursorBinding(
    "pages",
    siteId,
    window,
    filters,
    [includeDetails],
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          views: page.last.views,
          sessions: page.last.sessions,
          pathname: page.last.pathname,
          query: page.last.query,
          hash: page.last.hash,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodePagesCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  includeDetails: boolean,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageAggregateCursor | null> {
  const binding = await pageCursorBinding(
    "pages",
    siteId,
    window,
    filters,
    [includeDetails],
    audience,
  );
  return decodePageCursor(env, binding, cursor, "pages", pageAggregateCursor);
}

export async function queryPageTabsAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<{
  path: DimensionRow[];
  title: DimensionRow[];
  hostname: DimensionRow[];
  entry: DimensionRow[];
  exit: DimensionRow[];
}> {
  return queryPageTabsFromD1(env, siteId, window, filters, limit);
}

export interface PagesWithTabsResult {
  readonly pages: PageResult<PageRow>;
  readonly tabs: {
    path: DimensionRow[];
    title: DimensionRow[];
    hostname: DimensionRow[];
    entry: DimensionRow[];
    exit: DimensionRow[];
  };
}

/**
 * Reads the paginated page rows and the five page tabs from one materialized
 * visits relation. The protocol adapter uses this only when tabs are
 * requested, keeping the regular pages query and its cursor contract intact.
 */
export async function queryPagesWithTabsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
  cursor?: PageAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PagesWithTabsResult> {
  const preparedDataset = scopedDatasetFor(siteId, window, filters);
  const expandedDataset =
    preparedDataset ??
    scopedDatasetForUnpreparedReader(
      "pages",
      siteId,
      window,
      filters,
      "session",
    );
  const scopedDataset = preparedDataset ?? expandedDataset;
  const filter = preparedDataset
    ? null
    : buildVisitFilterSql(filters, "rv", { window });
  const observationVisitRelation = preparedDataset
    ? preparedDataset.visitRelation
    : expandedDataset
      ? "scope_raw_visits"
      : "visit_source";
  const edgeVisitRelation =
    preparedDataset || !expandedDataset
      ? "filtered_visits"
      : expandedDataset.visitRelation;
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const cursorClause = cursor
    ? `
WHERE views < ?
   OR (views = ? AND sessions < ?)
   OR (views = ? AND sessions = ? AND pathname > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue > ?)
   OR (views = ? AND sessions = ? AND pathname = ? AND queryValue = ? AND hashValue > ?)`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? visitSource},
filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    ${queryExpr} AS queryValue,
    ${hashExpr} AS hashValue,
    TRIM(COALESCE(pathname, '')) AS pathValue,
    session_id,
    visitor_id,
    started_at,
    visit_id,
    TRIM(COALESCE(title, '')) AS title,
    TRIM(COALESCE(hostname, '')) AS hostname
  FROM ${observationVisitRelation} rv
  ${filter?.clause ?? ""}
),
page_rollup AS (
  SELECT
    pathname,
    queryValue,
    hashValue,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
  FROM filtered_visits
  GROUP BY pathname, queryValue, hashValue
),
page_candidates AS (
  SELECT
    pathname,
    queryValue,
    hashValue,
    views,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY views DESC, sessions DESC, pathname ASC, queryValue ASC, hashValue ASC
    ) AS pageRank
  FROM page_rollup
  ${cursorClause}
),
page_rows AS (
  SELECT
    'page' AS rowType,
    '' AS cardType,
    pathname,
    queryValue,
    hashValue,
    '' AS value,
    views,
    sessions,
    0 AS visitors,
    pageRank AS rowRank
  FROM page_candidates
  ORDER BY pageRank ASC
  LIMIT ?
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM ${edgeVisitRelation} vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entry,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exit
  FROM ranked_session_visits
  GROUP BY session_id
),
card_rows AS (
  SELECT
    'path' AS card_type,
    pathValue AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE pathValue != ''
  GROUP BY pathValue
  UNION ALL
  SELECT
    'title' AS card_type,
    title AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE title != ''
  GROUP BY title
  UNION ALL
  SELECT
    'hostname' AS card_type,
    hostname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE hostname != ''
  GROUP BY hostname
  UNION ALL
  SELECT
    'entry' AS card_type,
    entry AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE entry != ''
  GROUP BY entry
  UNION ALL
  SELECT
    'exit' AS card_type,
    exit AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE exit != ''
  GROUP BY exit
),
ranked_cards AS (
  SELECT
    card_type,
    value,
    views,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY card_type
      ORDER BY views DESC, sessions DESC, value ASC
    ) AS cardRank
  FROM card_rows
)
SELECT rowType, cardType, pathname, queryValue, hashValue, value,
  views, sessions, visitors, rowRank
FROM page_rows
UNION ALL
SELECT
  'tab' AS rowType,
  card_type AS cardType,
  '' AS pathname,
  '' AS queryValue,
  '' AS hashValue,
  value,
  views,
  sessions,
  visitors,
  cardRank AS rowRank
FROM ranked_cards
WHERE cardRank <= ?
ORDER BY rowType ASC, cardType ASC, rowRank ASC, value ASC
`;
  const cursorBindings = cursor
    ? [
        cursor.views,
        cursor.views,
        cursor.sessions,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.views,
        cursor.sessions,
        cursor.pathname,
        cursor.query,
        cursor.hash,
      ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window)]),
    ...(filter?.bindings ?? []),
    ...cursorBindings,
    limit + 1,
    limit,
  ]);
  const pageRows = rows
    .filter((row) => row.rowType === "page")
    .map((row) => ({
      pathname: String(row.pathname ?? ""),
      query: String(row.queryValue ?? ""),
      hash: String(row.hashValue ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
    }));
  const page = pageResult(pageRows, limit);
  const binding = await pageCursorBinding(
    "pages",
    siteId,
    window,
    filters,
    [includeDetails],
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          views: page.last.views,
          sessions: page.last.sessions,
          pathname: page.last.pathname,
          query: page.last.query,
          hash: page.last.hash,
        })
      : null;
  const byCard = new Map<string, DimensionRow[]>();
  for (const row of rows.filter((item) => item.rowType === "tab")) {
    const card = String(row.cardType ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    pages: {
      items: page.rows,
      pagination: {
        limit,
        returned: page.rows.length,
        hasMore: page.hasMore,
        nextCursor,
      },
    },
    tabs: {
      path: byCard.get("path") ?? [],
      title: byCard.get("title") ?? [],
      hostname: byCard.get("hostname") ?? [],
      entry: byCard.get("entry") ?? [],
      exit: byCard.get("exit") ?? [],
    },
  };
}

export async function queryPageCardMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options?: {
    pathnames?: string[];
    limit?: number;
    cursor?: PageDashboardCursor | null;
    search?: string;
    sort?: PagesDashboardMetric;
    direction?: SortDirection;
  },
): Promise<PageCardAggregateRow[]> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const requestedPathnames = Array.from(
    new Set(
      (options?.pathnames ?? [])
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
  const pathnameCondition =
    requestedPathnames.length > 0
      ? `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`
      : "";
  const filteredClause = appendSqlConditions(filter?.clause ?? "", [
    `TRIM(COALESCE(pathname, '')) != ''`,
    pathnameCondition,
  ]);
  const hasLimit = typeof options?.limit === "number";
  const cursor = options?.cursor;
  const sort = options?.sort ?? "views";
  const direction = options?.direction ?? "desc";
  const sortColumns: Record<
    PagesDashboardMetric,
    { primary: string; secondary: string }
  > = {
    views: { primary: "views", secondary: "sessions" },
    visitors: { primary: "visitors", secondary: "views" },
    sessions: { primary: "sessions", secondary: "views" },
    bounceRate: { primary: "bounceRate", secondary: "sessions" },
    pagesPerSession: { primary: "pagesPerSession", secondary: "views" },
    avgDurationMs: { primary: "avgDurationMs", secondary: "views" },
  };
  const { primary, secondary } = sortColumns[sort];
  const operator = direction === "asc" ? ">" : "<";
  const searchClause = options?.search?.trim()
    ? `AND LOWER(pr.pathname) LIKE ? ESCAPE '\\'`
    : "";
  const cursorClause = cursor
    ? `AND (
        pr.${primary} ${operator} ?
        OR (pr.${primary} = ? AND pr.${secondary} ${operator} ?)
        OR (pr.${primary} = ? AND pr.${secondary} = ? AND pr.pathname > ?)
      )`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    session_id AS sessionId,
    visitor_id AS visitorId,
    duration_ms AS durationMs
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filteredClause}
),
path_rollup AS (
  SELECT
    pathname,
    count(*) AS views,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
    COALESCE(sum(CASE WHEN durationMs IS NOT NULL AND durationMs >= 0 THEN durationMs ELSE 0 END), 0) AS totalDuration
  FROM filtered_visits
  GROUP BY pathname
),
path_session_rollup AS (
  SELECT
    pathname,
    sessionId,
    count(*) AS visitCount
  FROM filtered_visits
  WHERE sessionId != ''
  GROUP BY pathname, sessionId
),
path_bounce_rollup AS (
  SELECT
    pathname,
    count(*) AS bounces
  FROM path_session_rollup
  WHERE visitCount = 1
  GROUP BY pathname
),
path_metrics AS (
  SELECT
    pr.pathname AS pathname,
    pr.views AS views,
    pr.sessions AS sessions,
    pr.visitors AS visitors,
    COALESCE(pb.bounces, 0) AS bounces,
    pr.totalDuration AS totalDuration,
    0 AS durationViews,
    CASE WHEN pr.sessions <= 0 THEN 0.0
      ELSE COALESCE(pb.bounces, 0) * 1.0 / pr.sessions END AS bounceRate,
    CASE WHEN pr.sessions <= 0 THEN 0.0
      ELSE pr.views * 1.0 / pr.sessions END AS pagesPerSession,
    CASE WHEN pr.sessions <= 0 THEN 0.0
      ELSE pr.totalDuration * 1.0 / pr.sessions END AS avgDurationMs
  FROM path_rollup pr
  LEFT JOIN path_bounce_rollup pb ON pb.pathname = pr.pathname
)
SELECT
  pr.pathname AS pathname,
  pr.views AS views,
  pr.sessions AS sessions,
  pr.visitors AS visitors,
  pr.bounces AS bounces,
  pr.totalDuration AS totalDuration,
  pr.durationViews AS durationViews
FROM path_metrics pr
WHERE 1 = 1
${searchClause}
${cursorClause}
ORDER BY pr.${primary} ${direction}, pr.${secondary} ${direction}, pr.pathname ASC
${hasLimit ? "LIMIT ?" : ""}
`;
  const searchBindings = options?.search?.trim()
    ? [
        `%${options.search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...requestedPathnames,
      ...searchBindings,
      ...(cursor
        ? [
            cursor.primary,
            cursor.primary,
            cursor.secondary,
            cursor.primary,
            cursor.secondary,
            cursor.pathname,
          ]
        : []),
      ...(hasLimit ? [options?.limit ?? 0] : []),
    ])
  ).map((row) => ({
    pathname: String(row.pathname ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  }));
}

export async function queryPageCardTitlesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  pathnames: string[],
  titleLimit: number,
): Promise<PageCardTitleRow[]> {
  const requestedPathnames = Array.from(
    new Set(
      pathnames
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
  if (requestedPathnames.length === 0) return [];

  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const filteredClause = appendSqlConditions(filter?.clause ?? "", [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT pathname, title
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filteredClause}
),
title_rollup AS (
  SELECT
    pathname,
    TRIM(COALESCE(title, '')) AS title,
    count(*) AS views
  FROM filtered_visits
  WHERE TRIM(COALESCE(title, '')) != ''
  GROUP BY pathname, TRIM(COALESCE(title, ''))
),
ranked_titles AS (
  SELECT
    pathname,
    title,
    views,
    ROW_NUMBER() OVER (PARTITION BY pathname ORDER BY views DESC, title ASC) AS titleRank
  FROM title_rollup
)
SELECT
  pathname,
  title,
  views
FROM ranked_titles
WHERE titleRank <= ?
ORDER BY pathname ASC, titleRank ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...requestedPathnames,
      titleLimit,
    ])
  ).map((row) => ({
    pathname: String(row.pathname ?? ""),
    title: String(row.title ?? ""),
    views: Number(row.views ?? 0),
  }));
}

export async function queryPageCardTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  pathnames: string[],
): Promise<PageCardTrendRow[]> {
  const requestedPathnames = Array.from(
    new Set(
      pathnames
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
  if (requestedPathnames.length === 0) return [];

  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "startedAt");
  const filteredClause = appendSqlConditions(filter?.clause ?? "", [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    pathname,
    started_at AS startedAt,
    visitor_id AS visitorId
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filteredClause}
)
SELECT
  pathname,
  ${bucket.sql} AS bucket,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY pathname, bucket
ORDER BY pathname ASC, bucket ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...requestedPathnames,
      ...bucket.bindings,
    ])
  ).map((row) => ({
    pathname: String(row.pathname ?? ""),
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

async function queryPageCardDetailsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  pathnames: string[],
  titleLimit: number,
): Promise<{ titles: PageCardTitleRow[]; trend: PageCardTrendRow[] }> {
  const requestedPathnames = Array.from(
    new Set(
      pathnames
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
  if (requestedPathnames.length === 0) return { titles: [], trend: [] };

  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "startedAt");
  const filteredClause = appendSqlConditions(filter?.clause ?? "", [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    title,
    started_at AS startedAt,
    visitor_id AS visitorId
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filteredClause}
),
title_rollup AS (
  SELECT
    pathname,
    TRIM(COALESCE(title, '')) AS title,
    count(*) AS views
  FROM filtered_visits
  WHERE TRIM(COALESCE(title, '')) != ''
  GROUP BY pathname, TRIM(COALESCE(title, ''))
),
ranked_titles AS (
  SELECT
    pathname,
    title,
    views,
    ROW_NUMBER() OVER (PARTITION BY pathname ORDER BY views DESC, title ASC) AS titleRank
  FROM title_rollup
),
trend_rollup AS (
  SELECT
    pathname,
    ${bucket.sql} AS bucket,
    count(*) AS views,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY pathname, bucket
)
SELECT
  'title' AS rowKind,
  pathname,
  title,
  views,
  NULL AS bucket,
  NULL AS visitors,
  titleRank AS rowOrder
FROM ranked_titles
WHERE titleRank <= ?
UNION ALL
SELECT
  'trend' AS rowKind,
  pathname,
  NULL AS title,
  views,
  bucket,
  visitors,
  bucket AS rowOrder
FROM trend_rollup
ORDER BY rowKind ASC, pathname ASC, rowOrder ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])]),
    ...requestedPathnames,
    ...bucket.bindings,
    titleLimit,
  ]);
  const titles: PageCardTitleRow[] = [];
  const trend: PageCardTrendRow[] = [];
  for (const row of rows) {
    if (row.rowKind === "title") {
      titles.push({
        pathname: String(row.pathname ?? ""),
        title: String(row.title ?? ""),
        views: Number(row.views ?? 0),
      });
      continue;
    }
    if (row.rowKind === "trend") {
      const trendBucket = Number(row.bucket ?? 0);
      trend.push({
        pathname: String(row.pathname ?? ""),
        bucket: trendBucket,
        timestampMs: timeBucketTimestamp(buckets, trendBucket),
        views: Number(row.views ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }
  }
  return { titles, trend };
}

export async function queryReferrerAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    diagnostics,
    search,
  );
}

/** Explicit Top-N reader for reports/cards. It intentionally has no cursor. */
export async function queryTopReferrersFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    diagnostics,
    search,
  );
}

/** Explicit aggregate for referrer summary cards. It is intentionally
 * independent from the paginated referrer collection. */
export async function queryReferrerSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  topN: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<ReferrerSummaryRow> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const source = scopedDataset?.visitRelation ?? "visit_source";
  const ctes = scopedDataset?.ctes ?? buildVisitSourceCte();
  const bindings = scopedDataset
    ? scopedDataset.bindings.map((binding) => binding.value)
    : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `
WITH
${ctes},
filtered_visits AS MATERIALIZED (
  SELECT referrer_host, referrer_url
  FROM ${source}
  ${filter?.clause ?? ""}
),
summary_row AS (
  SELECT
    'summary' AS rowType,
    '' AS referrer,
    count(*) AS totalViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) = '' THEN 1 ELSE 0 END) AS directViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 1 ELSE 0 END) AS externalViews,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_host, '')), '')) AS uniqueDomains,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_url, '')), '')) AS uniqueLinks,
    0 AS views,
    0 AS rowRank
  FROM filtered_visits
),
top_rollup AS (
  SELECT
    TRIM(COALESCE(referrer_host, '')) AS referrer,
    count(*) AS views
  FROM filtered_visits
  WHERE TRIM(COALESCE(referrer_host, '')) != ''
  GROUP BY referrer
),
top_rows AS (
  SELECT
    'top' AS rowType,
    referrer,
    NULL AS totalViews,
    NULL AS directViews,
    NULL AS externalViews,
    NULL AS uniqueDomains,
    NULL AS uniqueLinks,
    views,
    ROW_NUMBER() OVER (ORDER BY views DESC, referrer ASC) AS rowRank
  FROM top_rollup
)
SELECT rowType, referrer, totalViews, directViews, externalViews,
  uniqueDomains, uniqueLinks, views, rowRank
FROM (
  SELECT * FROM summary_row
  UNION ALL
  SELECT * FROM top_rows
)
WHERE rowType = 'summary' OR rowRank <= ?
ORDER BY CASE rowType WHEN 'summary' THEN 0 ELSE 1 END, rowRank ASC
`,
    [...bindings, topN + 1],
    diagnostics,
  );
  const summary = rows.find((row) => row.rowType === "summary") ?? {};
  const topRows = rows.filter((row) => row.rowType === "top");
  return {
    totalViews: Number(summary.totalViews ?? 0),
    directViews: Number(summary.directViews ?? 0),
    externalViews: Number(summary.externalViews ?? 0),
    uniqueDomains: Number(summary.uniqueDomains ?? 0),
    uniqueLinks: Number(summary.uniqueLinks ?? 0),
    truncated: topRows.length > topN,
    topSources: topRows.slice(0, topN).map((row) => ({
      referrer: String(row.referrer ?? ""),
      views: Number(row.views ?? 0),
    })),
  };
}

/** Keyset-paginated referrer aggregate. */
export async function queryReferrersPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  search?: string,
  cursor?: ReferrerAggregateCursor | null,
  diagnostics?: D1ReadDiagnostics,
  audience: QueryAudience = "private-dashboard",
  sortBy: ReferrerPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<PageResult<ReferrerRow>> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const primary = sortBy === "visitors" ? "visitors" : "views";
  const secondary = sortBy === "visitors" ? "views" : "sessions";
  const operator = sortDirection === "asc" ? ">" : "<";
  const cursorClause = cursor
    ? `
WHERE ${primary} ${operator} ?
   OR (${primary} = ? AND ${secondary} ${operator} ?)
   OR (${primary} = ? AND ${secondary} = ? AND referrer > ?)`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
rollup AS (
  SELECT
    COALESCE(${keyExpr}, '') AS referrer,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY referrer
  ${search ? "HAVING LOWER(referrer) LIKE ? ESCAPE '\\'" : ""}
)
SELECT referrer, views, sessions, visitors
FROM rollup
${cursorClause}
  ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`;
  const orderedSql = sql.replace(
    "ORDER BY views DESC, sessions DESC, referrer ASC",
    `ORDER BY ${primary} ${sortDirection}, ${secondary} ${sortDirection}, referrer ASC`,
  );
  const cursorBindings = cursor
    ? [
        cursor.primary,
        cursor.primary,
        cursor.secondary,
        cursor.primary,
        cursor.secondary,
        cursor.referrer,
      ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    orderedSql,
    [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...(search
        ? [
            `%${search
              .trim()
              .toLowerCase()
              .replaceAll("\\", "\\\\")
              .replaceAll("%", "\\%")
              .replaceAll("_", "\\_")}%`,
          ]
        : []),
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await pageCursorBinding(
    "referrers",
    siteId,
    window,
    filters,
    [includeFullUrl, search?.trim().toLowerCase() ?? "", sortBy, sortDirection],
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          primary: sortBy === "visitors" ? page.last.visitors : page.last.views,
          secondary:
            sortBy === "visitors" ? page.last.views : page.last.sessions,
          referrer: page.last.referrer,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeReferrersCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  includeFullUrl: boolean,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: ReferrerPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<ReferrerAggregateCursor | null> {
  const binding = await pageCursorBinding(
    "referrers",
    siteId,
    window,
    filters,
    [includeFullUrl, search?.trim().toLowerCase() ?? "", sortBy, sortDirection],
    audience,
  );
  return decodePageCursor(
    env,
    binding,
    cursor,
    "referrers",
    referrerAggregateCursor,
  );
}

export async function queryDimensionAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  d1Expr: string,
  options?: { excludeEmpty?: boolean },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return queryVisitDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    d1Expr,
    options,
    diagnostics,
  );
}

export interface PageDashboardMetrics {
  readonly views: number;
  readonly visitors: number;
  readonly sessions: number;
  readonly bounceRate: number;
  readonly pagesPerSession: number;
  readonly avgDurationMs: number;
}

export interface PageDashboardItem {
  readonly pathname: string;
  readonly titles: readonly string[];
  readonly trend: readonly {
    readonly timestampMs: number;
    readonly views: number;
    readonly visitors: number;
  }[];
  readonly referenceTrend?: readonly {
    readonly timestampMs: number;
    readonly views: number;
    readonly visitors: number;
  }[];
  readonly metrics: PageDashboardMetrics;
  readonly changeRates: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "pagesPerSession"
      | "avgDurationMs",
      number | null
    >
  >;
  readonly reference?: PageDashboardMetrics;
  readonly change?: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "pagesPerSession"
      | "avgDurationMs",
      { readonly absolute: number; readonly relative: number | null }
    >
  >;
}

export interface PagesDashboardResult {
  readonly interval: Interval;
  readonly items: readonly PageDashboardItem[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export interface PagesDashboardReaderInput {
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly interval: Interval;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
  readonly search?: string;
  readonly sort?: {
    readonly key: PagesDashboardMetric;
    readonly direction: SortDirection;
  };
  readonly comparison?: PagesDashboardComparisonQuery;
  readonly audience?: QueryAudience;
}

export interface PageDashboardCursor {
  readonly primary: number;
  readonly secondary: number;
  readonly pathname: string;
}

export interface PageDashboardComparisonCursor {
  readonly sortClass: number;
  readonly primary: number;
  readonly secondary: number;
  readonly pathname: string;
}

async function pagesDashboardCursorBinding(
  siteId: string,
  input: PagesDashboardReaderInput,
): Promise<string> {
  return pageCursorBinding(
    "pages-dashboard",
    siteId,
    input.window,
    input.filters,
    [
      input.interval,
      input.search?.trim().toLowerCase() ?? "",
      input.sort?.key ?? "views",
      input.sort?.direction ?? "desc",
    ],
    input.audience ?? "private-dashboard",
  );
}

function pageDashboardCursor(value: unknown): PageDashboardCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["primary", "secondary", "pathname"]) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.pathname === "string"
    ? (candidate as unknown as PageDashboardCursor)
    : null;
}

function queryWindowFromTime(time: {
  readonly range: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
}): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

interface PageDashboardComparisonSide {
  readonly ctes: string;
  readonly relation: string;
  readonly filterClause: string;
  readonly bindings: readonly (string | number | null)[];
}

function renamedPageDashboardScopedDataset(
  dataset: ReturnType<typeof scopedDatasetFor>,
  prefix: string,
): PageDashboardComparisonSide | null {
  if (!dataset) return null;
  const rename = (value: string) =>
    value
      .replace(/\bscope_[A-Za-z0-9_]*/g, (name) => `${prefix}_${name}`)
      .replace(/\bvisit_source\b/g, `${prefix}_visit_source`);
  return {
    ctes: rename(dataset.ctes),
    relation: rename(dataset.visitRelation),
    filterClause: "",
    bindings: dataset.bindings.map((binding) => binding.value),
  };
}

function pageDashboardComparisonSide(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  prefix: string,
): PageDashboardComparisonSide {
  const scoped = renamedPageDashboardScopedDataset(
    scopedDatasetFor(siteId, window, filters),
    prefix,
  );
  if (scoped) return scoped;
  const relation = `${prefix}_visit_source`;
  const filter = buildVisitFilterSql(filters, relation, { window });
  return {
    ctes: buildVisitSourceCte().replace(/\bvisit_source\b/g, relation),
    relation,
    filterClause: filter.clause,
    bindings: [...visitSourceBindings(siteId, window), ...filter.bindings],
  };
}

function pageDashboardMetricColumn(
  metric: PagesDashboardMetric,
  prefix: "current" | "reference",
): string {
  const name =
    metric === "bounceRate"
      ? "bounce_rate"
      : metric === "pagesPerSession"
        ? "pages_per_session"
        : metric === "avgDurationMs"
          ? "avg_duration_ms"
          : metric;
  return `${prefix}_${name}`;
}

function pageDashboardSortColumns(
  metric: PagesDashboardMetric,
  sortBy: PagesDashboardSortBy,
): { primary: string; secondary: string } {
  if (sortBy === "change") {
    return { primary: "change_relative", secondary: "pathname" };
  }
  const prefix = sortBy === "reference" ? "reference" : "current";
  const primary = pageDashboardMetricColumn(metric, prefix);
  const secondary = pageDashboardMetricColumn(
    metric,
    prefix === "current" ? "reference" : "current",
  );
  return { primary, secondary };
}

function pageDashboardComparisonCursor(
  value: unknown,
): PageDashboardComparisonCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "sortClass",
    "primary",
    "secondary",
    "pathname",
  ]) &&
    typeof candidate.sortClass === "number" &&
    Number.isFinite(candidate.sortClass) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.pathname === "string"
    ? (candidate as unknown as PageDashboardComparisonCursor)
    : null;
}

async function pagesDashboardComparisonCursorBinding(
  siteId: string,
  input: PagesDashboardReaderInput,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
): Promise<string> {
  return pageCursorBinding(
    "pages-dashboard-comparison",
    siteId,
    current,
    currentFilters,
    [
      input.interval,
      input.search?.trim().toLowerCase() ?? "",
      input.comparison?.metric ?? "views",
      input.comparison?.sortBy ?? "current",
      input.comparison?.direction ?? "desc",
      reference.startMs,
      reference.endExclusiveMs,
      reference.timeZone,
      filterFingerprint(referenceFilters, analyticsFilterRegistry),
      effectiveScopeForPagination(referenceFilters),
    ],
    input.audience ?? "private-dashboard",
  );
}

async function queryPageDashboardComparisonPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  options: {
    metric: PagesDashboardMetric;
    sortBy: PagesDashboardSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: PageDashboardComparisonCursor | null,
): Promise<{
  rows: Array<{
    current: PageCardAggregateRow;
    reference: PageCardAggregateRow;
  }>;
  hasMore: boolean;
}> {
  const currentSide = pageDashboardComparisonSide(
    siteId,
    current,
    currentFilters,
    "current",
  );
  const referenceSide = pageDashboardComparisonSide(
    siteId,
    reference,
    referenceFilters,
    "reference",
  );
  const currentMetric = pageDashboardMetricColumn(options.metric, "current");
  const referenceMetric = pageDashboardMetricColumn(
    options.metric,
    "reference",
  );
  const relative = `CASE WHEN ${referenceMetric} = 0 THEN CASE WHEN ${currentMetric} = 0 THEN 0.0 ELSE NULL END ELSE (${currentMetric} - ${referenceMetric}) * 1.0 / ${referenceMetric} END`;
  const changeClass = `CASE WHEN ${referenceMetric} = 0 AND ${currentMetric} > 0 THEN 1 ELSE 0 END`;
  const ordering = pageDashboardSortColumns(options.metric, options.sortBy);
  const direction = options.direction;
  const operator = direction === "asc" ? ">" : "<";
  const orderExpression =
    options.sortBy === "change"
      ? `change_class ${direction}, change_relative ${direction}, pathname ASC`
      : `${ordering.primary} ${direction}, ${ordering.secondary} ${direction}, pathname ASC`;
  const cursorClause = cursor
    ? options.sortBy === "change"
      ? `AND (
          change_class ${operator} ?
          OR (change_class = ? AND (
            change_relative ${operator} ?
            OR (change_relative = ? AND pathname > ?)
          ))
        )`
      : `AND (
          ${ordering.primary} ${operator} ?
          OR (${ordering.primary} = ? AND ${ordering.secondary} ${operator} ?)
          OR (${ordering.primary} = ? AND ${ordering.secondary} = ? AND pathname > ?)
        )`
    : "";
  const searchClause = options.search?.trim()
    ? "AND LOWER(pathname) LIKE ? ESCAPE '\\'"
    : "";
  const sideSql = (side: PageDashboardComparisonSide, prefix: string) => `
${prefix}_visits AS MATERIALIZED (
  SELECT pathname, session_id AS sessionId, visitor_id AS visitorId,
    duration_ms AS durationMs
  FROM ${side.relation}
  ${side.filterClause || "WHERE 1 = 1"}
  AND TRIM(COALESCE(pathname, '')) != ''
),
${prefix}_path_rollup AS (
  SELECT pathname,
    count(*) AS ${prefix}_views,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS ${prefix}_sessions,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS ${prefix}_visitors,
    COALESCE(sum(CASE WHEN durationMs IS NOT NULL AND durationMs >= 0 THEN durationMs ELSE 0 END), 0) AS ${prefix}_total_duration
  FROM ${prefix}_visits
  GROUP BY pathname
),
${prefix}_path_sessions AS (
  SELECT pathname, sessionId, count(*) AS visitCount
  FROM ${prefix}_visits
  WHERE sessionId != ''
  GROUP BY pathname, sessionId
),
${prefix}_path_bounces AS (
  SELECT pathname, count(*) AS ${prefix}_bounces
  FROM ${prefix}_path_sessions
  WHERE visitCount = 1
  GROUP BY pathname
),
${prefix}_metrics AS (
  SELECT
    pr.pathname AS pathname,
    pr.${prefix}_views AS ${prefix}_views,
    pr.${prefix}_sessions AS ${prefix}_sessions,
    pr.${prefix}_visitors AS ${prefix}_visitors,
    COALESCE(pb.${prefix}_bounces, 0) AS ${prefix}_bounces,
    pr.${prefix}_total_duration AS ${prefix}_total_duration,
    0 AS ${prefix}_duration_views,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE COALESCE(pb.${prefix}_bounces, 0) * 1.0 / pr.${prefix}_sessions END AS ${prefix}_bounce_rate,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE pr.${prefix}_views * 1.0 / pr.${prefix}_sessions END AS ${prefix}_pages_per_session,
    CASE WHEN pr.${prefix}_sessions <= 0 THEN 0.0 ELSE pr.${prefix}_total_duration * 1.0 / pr.${prefix}_sessions END AS ${prefix}_avg_duration_ms
  FROM ${prefix}_path_rollup pr
  LEFT JOIN ${prefix}_path_bounces pb ON pb.pathname = pr.pathname
)`;
  const sql = `
WITH
${currentSide.ctes},
${referenceSide.ctes},
${sideSql(currentSide, "current")},
${sideSql(referenceSide, "reference")},
joined AS (
  SELECT keys.pathname,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(c.current_bounces, 0) AS current_bounces,
    COALESCE(c.current_total_duration, 0) AS current_total_duration,
    COALESCE(c.current_duration_views, 0) AS current_duration_views,
    COALESCE(c.current_bounce_rate, 0) AS current_bounce_rate,
    COALESCE(c.current_pages_per_session, 0) AS current_pages_per_session,
    COALESCE(c.current_avg_duration_ms, 0) AS current_avg_duration_ms,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors,
    COALESCE(r.reference_bounces, 0) AS reference_bounces,
    COALESCE(r.reference_total_duration, 0) AS reference_total_duration,
    COALESCE(r.reference_duration_views, 0) AS reference_duration_views,
    COALESCE(r.reference_bounce_rate, 0) AS reference_bounce_rate,
    COALESCE(r.reference_pages_per_session, 0) AS reference_pages_per_session,
    COALESCE(r.reference_avg_duration_ms, 0) AS reference_avg_duration_ms
  FROM (
    SELECT pathname FROM current_metrics
    UNION
    SELECT pathname FROM reference_metrics
  ) keys
  LEFT JOIN current_metrics c ON c.pathname = keys.pathname
  LEFT JOIN reference_metrics r ON r.pathname = keys.pathname
),
projected AS (
  SELECT *, ${relative} AS change_relative, ${changeClass} AS change_class
  FROM joined
)
SELECT * FROM projected
WHERE 1 = 1
${searchClause}
${cursorClause}
ORDER BY ${orderExpression}
LIMIT ?
`;
  const searchBindings = options.search?.trim()
    ? [
        `%${options.search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const cursorBindings = cursor
    ? options.sortBy === "change"
      ? [
          cursor.sortClass,
          cursor.sortClass,
          cursor.primary,
          cursor.primary,
          cursor.pathname,
        ]
      : [
          cursor.primary,
          cursor.primary,
          cursor.secondary,
          cursor.primary,
          cursor.secondary,
          cursor.pathname,
        ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...currentSide.bindings,
    ...referenceSide.bindings,
    ...searchBindings,
    ...cursorBindings,
    limit + 1,
  ]);
  const number = (row: Record<string, unknown>, key: string) =>
    Number(row[key] ?? 0);
  const mapped = rows.map((row) => ({
    current: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "current_views"),
      sessions: number(row, "current_sessions"),
      visitors: number(row, "current_visitors"),
      bounces: number(row, "current_bounces"),
      totalDuration: number(row, "current_total_duration"),
      durationViews: number(row, "current_duration_views"),
    },
    reference: {
      pathname: String(row.pathname ?? ""),
      views: number(row, "reference_views"),
      sessions: number(row, "reference_sessions"),
      visitors: number(row, "reference_visitors"),
      bounces: number(row, "reference_bounces"),
      totalDuration: number(row, "reference_total_duration"),
      durationViews: number(row, "reference_duration_views"),
    },
  }));
  return {
    rows: mapped.slice(0, limit),
    hasMore: mapped.length > limit,
  };
}

/**
 * Pure dashboard-page reader. Pagination parsing and HTTP serialization stay
 * in its protocol adapter.
 */
export async function queryPagesDashboard(
  env: Env,
  siteId: string,
  input: PagesDashboardReaderInput,
): Promise<PagesDashboardResult> {
  const { filters, interval, page, window } = input;
  const comparison = input.comparison;
  const comparisonReference = comparison
    ? {
        window: queryWindowFromTime(comparison.reference.time),
        filters: comparison.reference.filters ?? filters,
      }
    : null;
  let currentRows: PageCardAggregateRow[];
  let hasMore: boolean;
  let nextCursor: string | null;
  let referenceByPath = new Map<string, PageCardAggregateRow>();

  if (comparison) {
    const referenceWindow = comparisonReference!.window;
    const comparisonCursor =
      await decodePageCursor<PageDashboardComparisonCursor>(
        env,
        await pagesDashboardComparisonCursorBinding(
          siteId,
          input,
          window,
          filters,
          referenceWindow,
          comparisonReference!.filters,
        ),
        page.cursor,
        "pages-dashboard-comparison",
        pageDashboardComparisonCursor,
      );
    const comparisonPage = await queryPageDashboardComparisonPageFromD1(
      env,
      siteId,
      window,
      filters,
      referenceWindow,
      comparisonReference!.filters,
      page.limit,
      {
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
        search: input.search,
      },
      comparisonCursor,
    );
    currentRows = comparisonPage.rows.map((row) => row.current);
    referenceByPath = new Map(
      comparisonPage.rows.map((row) => [row.current.pathname, row.reference]),
    );
    hasMore = comparisonPage.hasMore;
    const lastPair = comparisonPage.rows.at(-1);
    nextCursor =
      hasMore && lastPair
        ? await encodePageCursor(
            env,
            await pagesDashboardComparisonCursorBinding(
              siteId,
              input,
              window,
              filters,
              referenceWindow,
              comparisonReference!.filters,
            ),
            (() => {
              const currentMetrics = mapPageCardMetrics(lastPair.current);
              const referenceMetrics = mapPageCardMetrics(lastPair.reference);
              const currentValue = currentMetrics[comparison.metric];
              const referenceValue = referenceMetrics[comparison.metric];
              const relative =
                referenceValue <= 0
                  ? currentValue <= 0
                    ? 0
                    : null
                  : (currentValue - referenceValue) / referenceValue;
              return {
                sortClass: referenceValue === 0 && currentValue > 0 ? 1 : 0,
                primary:
                  comparison.sortBy === "reference"
                    ? referenceValue
                    : comparison.sortBy === "change"
                      ? (relative ?? 0)
                      : currentValue,
                secondary:
                  comparison.sortBy === "current"
                    ? referenceValue
                    : comparison.sortBy === "reference"
                      ? currentValue
                      : 0,
                pathname: lastPair.current.pathname,
              };
            })(),
          )
        : null;
  } else {
    const cursor = await decodePageCursor<PageDashboardCursor>(
      env,
      await pagesDashboardCursorBinding(siteId, input),
      page.cursor,
      "pages-dashboard",
      pageDashboardCursor,
    );
    const requestedRows = await queryPageCardMetricsFromD1(
      env,
      siteId,
      window,
      filters,
      {
        limit: page.limit + 1,
        cursor,
        search: input.search,
        sort: input.sort?.key,
        direction: input.sort?.direction,
      },
    );
    hasMore = requestedRows.length > page.limit;
    currentRows = hasMore ? requestedRows.slice(0, page.limit) : requestedRows;
    const lastRow = currentRows.at(-1);
    nextCursor =
      hasMore && lastRow
        ? await encodePageCursor(
            env,
            await pagesDashboardCursorBinding(siteId, input),
            {
              primary:
                input.sort?.key === "visitors"
                  ? lastRow.visitors
                  : input.sort?.key === "sessions"
                    ? lastRow.sessions
                    : input.sort?.key === "bounceRate"
                      ? lastRow.sessions > 0
                        ? lastRow.bounces / lastRow.sessions
                        : 0
                      : input.sort?.key === "pagesPerSession"
                        ? lastRow.sessions > 0
                          ? lastRow.views / lastRow.sessions
                          : 0
                        : input.sort?.key === "avgDurationMs"
                          ? lastRow.sessions > 0
                            ? lastRow.totalDuration / lastRow.sessions
                            : 0
                          : lastRow.views,
              secondary:
                input.sort?.key === "views" || input.sort?.key === "bounceRate"
                  ? lastRow.sessions
                  : lastRow.views,
              pathname: lastRow.pathname,
            },
          )
        : null;
  }
  if (currentRows.length === 0) {
    return {
      interval,
      items: [],
      pagination: {
        limit: page.limit,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const pathnames = currentRows.map((row) => row.pathname);
  const previousStartMs = Math.max(
    window.startMs - (window.endExclusiveMs - window.startMs),
    0,
  );
  const previousWindow: QueryWindow = {
    startMs: previousStartMs,
    endExclusiveMs: window.startMs,
    nowMs: window.nowMs,
    timeZone: window.timeZone,
  };

  const [previousRows, details, comparisonDetails] = await Promise.all([
    comparison
      ? Promise.resolve([] as PageCardAggregateRow[])
      : queryPageCardMetricsFromD1(env, siteId, previousWindow, filters, {
          pathnames,
        }),
    queryPageCardDetailsFromD1(
      env,
      siteId,
      window,
      interval,
      filters,
      pathnames,
      3,
    ),
    comparisonReference
      ? queryPageCardDetailsFromD1(
          env,
          siteId,
          comparisonReference.window,
          interval,
          comparisonReference.filters,
          pathnames,
          0,
        )
      : Promise.resolve({ titles: [], trend: [] }),
  ]);

  const previousByPath = new Map<string, PageCardAggregateRow>();
  for (const row of previousRows) {
    previousByPath.set(row.pathname, row);
  }

  const titlesByPath = new Map<string, string[]>();
  for (const row of details.titles) {
    const titles = titlesByPath.get(row.pathname) ?? [];
    if (titles.length >= 3) continue;
    const title = row.title.trim();
    if (!title || titles.includes(title)) continue;
    titles.push(title);
    titlesByPath.set(row.pathname, titles);
  }

  const mapTrends = (rows: readonly PageCardTrendRow[]) => {
    const trends = new Map<
      string,
      Array<{ timestampMs: number; views: number; visitors: number }>
    >();
    for (const row of rows) {
      const trend = trends.get(row.pathname) ?? [];
      trend.push({
        timestampMs: row.timestampMs,
        views: row.views,
        visitors: row.visitors,
      });
      trends.set(row.pathname, trend);
    }
    return trends;
  };
  const trendByPath = mapTrends(details.trend);
  const comparisonTrendByPath = mapTrends(comparisonDetails.trend);

  return {
    interval,
    items: currentRows.map((row) => {
      const previousRow =
        (comparison
          ? referenceByPath.get(row.pathname)
          : previousByPath.get(row.pathname)) ?? emptyOverviewAggregateRow();
      const metrics = mapPageCardMetrics(row);
      const previousMetrics = mapPageCardMetrics(previousRow);
      const changes = {
        views: {
          absolute: metrics.views - previousMetrics.views,
          relative: percentChange(metrics.views, previousMetrics.views),
        },
        visitors: {
          absolute: metrics.visitors - previousMetrics.visitors,
          relative: percentChange(metrics.visitors, previousMetrics.visitors),
        },
        sessions: {
          absolute: metrics.sessions - previousMetrics.sessions,
          relative: percentChange(metrics.sessions, previousMetrics.sessions),
        },
        bounceRate: {
          absolute: metrics.bounceRate - previousMetrics.bounceRate,
          relative: percentChange(
            metrics.bounceRate,
            previousMetrics.bounceRate,
          ),
        },
        pagesPerSession: {
          absolute: metrics.pagesPerSession - previousMetrics.pagesPerSession,
          relative: percentChange(
            metrics.pagesPerSession,
            previousMetrics.pagesPerSession,
          ),
        },
        avgDurationMs: {
          absolute: metrics.avgDurationMs - previousMetrics.avgDurationMs,
          relative: percentChange(
            metrics.avgDurationMs,
            previousMetrics.avgDurationMs,
          ),
        },
      };
      return {
        pathname: normalizePathname(row.pathname),
        titles: titlesByPath.get(row.pathname) ?? [],
        trend: trendByPath.get(row.pathname) ?? [],
        ...(comparison
          ? { referenceTrend: comparisonTrendByPath.get(row.pathname) ?? [] }
          : {}),
        metrics,
        changeRates: {
          views: changes.views.relative,
          visitors: changes.visitors.relative,
          sessions: changes.sessions.relative,
          bounceRate: changes.bounceRate.relative,
          pagesPerSession: changes.pagesPerSession.relative,
          avgDurationMs: changes.avgDurationMs.relative,
        },
        ...(comparison ? { reference: previousMetrics, change: changes } : {}),
      };
    }),
    pagination: {
      limit: page.limit,
      returned: currentRows.length,
      hasMore,
      nextCursor,
    },
  };
}
