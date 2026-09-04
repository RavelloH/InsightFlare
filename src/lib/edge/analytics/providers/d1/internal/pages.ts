import {
  analyticsFilterRegistry,
  filterFingerprint,
  type QueryAudience,
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
  type PageResult,
  pageResult,
  paginationBinding,
} from "./pagination";
import { scopedDatasetFor } from "./scoped-dataset";

export interface PageAggregateCursor {
  readonly views: number;
  readonly sessions: number;
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
}

export interface ReferrerAggregateCursor {
  readonly views: number;
  readonly sessions: number;
  readonly visitors?: number;
  readonly referrer: string;
}

export type ReferrerPageSortKey = "views" | "visitors";

function pageCursorBinding(
  operation: string,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  extra: readonly unknown[] = [],
  audience: QueryAudience = "private-dashboard",
): Promise<string> {
  return paginationBinding([
    `analytics-${operation}-v1`,
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
  return decodePageCursor<PageAggregateCursor>(env, binding, cursor);
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

export async function queryPageCardMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options?: {
    pathnames?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<PageCardAggregateRow[]> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
)
SELECT
  pr.pathname AS pathname,
  pr.views AS views,
  pr.sessions AS sessions,
  pr.visitors AS visitors,
  COALESCE(pb.bounces, 0) AS bounces,
  pr.totalDuration AS totalDuration,
  0 AS durationViews
FROM path_rollup pr
LEFT JOIN path_bounce_rollup pb ON pb.pathname = pr.pathname
ORDER BY pr.views DESC, pr.sessions DESC, pr.pathname ASC
${hasLimit ? "LIMIT ? OFFSET ?" : ""}
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
      ...(hasLimit
        ? [options?.limit ?? 0, Math.max(0, options?.offset ?? 0)]
        : []),
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
  const source = scopedDataset?.visitRelation ?? "visit_source";
  const ctes = scopedDataset?.ctes ?? buildVisitSourceCte();
  const bindings = scopedDataset
    ? scopedDataset.bindings.map((binding) => binding.value)
    : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])];
  const summaryRows = await queryD1All<Record<string, unknown>>(
    env,
    `
WITH
${ctes},
filtered_visits AS (
  SELECT *
  FROM ${source}
  ${filter?.clause ?? ""}
)
SELECT
  count(*) AS totalViews,
  SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) = '' THEN 1 ELSE 0 END) AS directViews,
  SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 1 ELSE 0 END) AS externalViews,
  count(DISTINCT NULLIF(TRIM(COALESCE(referrer_host, '')), '')) AS uniqueDomains,
  count(DISTINCT NULLIF(TRIM(COALESCE(referrer_url, '')), '')) AS uniqueLinks
FROM filtered_visits
`,
    bindings,
    diagnostics,
  );
  const topRows = await queryD1All<Record<string, unknown>>(
    env,
    `
WITH
${ctes},
filtered_visits AS (
  SELECT *
  FROM ${source}
  ${filter?.clause ?? ""}
)
SELECT
  TRIM(COALESCE(referrer_host, '')) AS referrer,
  count(*) AS views
FROM filtered_visits
WHERE TRIM(COALESCE(referrer_host, '')) != ''
GROUP BY referrer
ORDER BY views DESC, referrer ASC
    LIMIT ?
`,
    [...bindings, topN + 1],
    diagnostics,
  );
  const summary = summaryRows[0] ?? {};
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
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
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
        sortBy === "visitors" ? (cursor.visitors ?? 0) : cursor.views,
        sortBy === "visitors" ? (cursor.visitors ?? 0) : cursor.views,
        sortBy === "visitors" ? cursor.views : cursor.sessions,
        sortBy === "visitors" ? (cursor.visitors ?? 0) : cursor.views,
        sortBy === "visitors" ? cursor.views : cursor.sessions,
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
          views: page.last.views,
          sessions: page.last.sessions,
          visitors: page.last.visitors,
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
  return decodePageCursor<ReferrerAggregateCursor>(env, binding, cursor);
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
}

export interface PagesDashboardResult {
  readonly interval: Interval;
  readonly data: readonly PageDashboardItem[];
  readonly meta: {
    readonly page: number;
    readonly pageSize: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextPage: number | null;
  };
}

export interface PagesDashboardReaderInput {
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly interval: Interval;
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
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
  const { filters, interval, offset, page, pageSize, window } = input;
  const requestedRows = await queryPageCardMetricsFromD1(
    env,
    siteId,
    window,
    filters,
    {
      limit: pageSize + 1,
      offset,
    },
  );
  const hasMore = requestedRows.length > pageSize;
  const currentRows = hasMore
    ? requestedRows.slice(0, pageSize)
    : requestedRows;
  if (currentRows.length === 0) {
    return {
      interval,
      data: [],
      meta: {
        page,
        pageSize,
        returned: 0,
        hasMore: false,
        nextPage: null,
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

  const [previousRows, details] = await Promise.all([
    queryPageCardMetricsFromD1(env, siteId, previousWindow, filters, {
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

  const trendByPath = new Map<
    string,
    Array<{
      timestampMs: number;
      views: number;
      visitors: number;
    }>
  >();
  for (const row of details.trend) {
    const trend = trendByPath.get(row.pathname) ?? [];
    trend.push({
      timestampMs: row.timestampMs,
      views: row.views,
      visitors: row.visitors,
    });
    trendByPath.set(row.pathname, trend);
  }

  return {
    interval,
    data: currentRows.map((row) => {
      const previousRow =
        previousByPath.get(row.pathname) ?? emptyOverviewAggregateRow();
      const metrics = mapPageCardMetrics(row);
      const previousMetrics = mapPageCardMetrics(previousRow);
      return {
        pathname: normalizePathname(row.pathname),
        titles: titlesByPath.get(row.pathname) ?? [],
        trend: trendByPath.get(row.pathname) ?? [],
        metrics,
        changeRates: {
          views: percentChange(metrics.views, previousMetrics.views),
          visitors: percentChange(metrics.visitors, previousMetrics.visitors),
          sessions: percentChange(metrics.sessions, previousMetrics.sessions),
          bounceRate: percentChange(
            metrics.bounceRate,
            previousMetrics.bounceRate,
          ),
          pagesPerSession: percentChange(
            metrics.pagesPerSession,
            previousMetrics.pagesPerSession,
          ),
          avgDurationMs: percentChange(
            metrics.avgDurationMs,
            previousMetrics.avgDurationMs,
          ),
        },
      };
    }),
    meta: {
      page,
      pageSize,
      returned: currentRows.length,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    },
  };
}
