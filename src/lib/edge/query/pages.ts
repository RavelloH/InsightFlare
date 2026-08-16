import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  DimensionRow,
  Interval,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  PageRow,
  QueryWindow,
  ReferrerRow,
} from "./core";
import {
  appendSqlConditions,
  badRequest,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  emptyOverviewAggregateRow,
  jsonResponseWith,
  mapDimensionRows,
  mapPageCardMetrics,
  mapPages,
  mapReferrers,
  mapTabs,
  normalizePathname,
  paginationOffset,
  parseBooleanFlag,
  parseFilters,
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
  percentChange,
  queryD1All,
  type ResponseContext,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
  withoutGeoFilter,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  queryPageTabsFromD1,
  queryReferrersFromD1,
  queryVisitDimensionFromD1,
} from "./dimensions";

export async function queryTopPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: DashboardFilters,
): Promise<PageRow[]> {
  const filter = buildVisitFilterSql(filters);
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
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
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
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
  filters: DashboardFilters,
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
  filters: DashboardFilters,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryPagesFromD1(env, siteId, window, filters, limit, includeDetails);
}

export async function queryPageTabsAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
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
  filters: DashboardFilters,
  options?: {
    pathnames?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<PageCardAggregateRow[]> {
  const filter = buildVisitFilterSql(filters);
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
  const filteredClause = appendSqlConditions(filter.clause, [
    `TRIM(COALESCE(pathname, '')) != ''`,
    pathnameCondition,
  ]);
  const hasLimit = typeof options?.limit === "number";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    session_id AS sessionId,
    visitor_id AS visitorId,
    duration_ms AS durationMs
  FROM visit_source
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
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
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
  filters: DashboardFilters,
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

  const filter = buildVisitFilterSql(filters);
  const filteredClause = appendSqlConditions(filter.clause, [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT pathname, title
  FROM visit_source
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
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
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
  filters: DashboardFilters,
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

  const filter = buildVisitFilterSql(filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "startedAt");
  const filteredClause = appendSqlConditions(filter.clause, [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    pathname,
    started_at AS startedAt,
    visitor_id AS visitorId
  FROM visit_source
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
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
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
  filters: DashboardFilters,
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

  const filter = buildVisitFilterSql(filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "startedAt");
  const filteredClause = appendSqlConditions(filter.clause, [
    `TRIM(COALESCE(pathname, '')) IN (${requestedPathnames.map(() => "?").join(", ")})`,
  ]);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    title,
    started_at AS startedAt,
    visitor_id AS visitorId
  FROM visit_source
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
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
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
  filters: DashboardFilters,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    diagnostics,
  );
}

export async function queryDimensionAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
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

export async function handlePages(
  env: Env,
  siteId: string,
  url: URL,
  includeTabs: boolean,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const includeDetails = parseBooleanFlag(url, "details");
  const pages = await queryPagesAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    includeDetails,
  );
  const payload: Record<string, unknown> = {
    ok: true,
    data: mapPages(pages),
  };
  if (includeTabs) {
    const tabs = await queryPageTabsAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    payload.tabs = {
      path: mapTabs(tabs.path),
      title: mapTabs(tabs.title),
      hostname: mapTabs(tabs.hostname),
      entry: mapTabs(tabs.entry),
      exit: mapTabs(tabs.exit),
    };
  }
  return jsonResponseWith(ctx!, payload);
}

export async function handlePagesDashboard(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");

  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const page = parseQueryLimit(url, "page", 1, 1, 10_000);
  const pageSize = parseQueryLimit(url, "pageSize", 12, 1, 24);
  const offset = paginationOffset(page, pageSize);
  if (offset === null) {
    return badRequest(
      "Pagination depth exceeds 20,000 rows; narrow the time range or filters",
    );
  }
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
    return jsonResponseWith(ctx!, {
      ok: true,
      interval,
      data: [],
      meta: {
        page,
        pageSize,
        returned: 0,
        hasMore: false,
        nextPage: null,
      },
    });
  }

  const pathnames = currentRows.map((row) => row.pathname);
  const previousTo = Math.max(window.fromMs - 1, 0);
  const previousFrom = Math.max(previousTo - (window.toMs - window.fromMs), 0);
  const previousWindow: QueryWindow = {
    fromMs: previousFrom,
    toMs: previousTo,
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

  return jsonResponseWith(ctx!, {
    ok: true,
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
  });
}

export async function handleReferrers(
  env: Env,
  siteId: string,
  url: URL,
  fallbackLimit = 20,
  allowFullUrlParam = true,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, fallbackLimit, 200);
  const includeFullUrl = allowFullUrlParam && parseBooleanFlag(url, "fullUrl");
  const rows = await queryReferrerAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
  );
  return jsonResponseWith(ctx!, { ok: true, data: mapReferrers(rows) });
}

export async function handleDimension(
  env: Env,
  siteId: string,
  url: URL,
  d1Expr: string,
  options?: {
    ignoreGeo?: boolean;
  },
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawFilters = parseFilters(url);
  const filters = options?.ignoreGeo
    ? withoutGeoFilter(rawFilters)
    : rawFilters;
  const limit = parseLimit(url, 20, 200);
  const rows = await queryDimensionAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    d1Expr,
  );
  return jsonResponseWith(ctx!, { ok: true, data: mapDimensionRows(rows) });
}
