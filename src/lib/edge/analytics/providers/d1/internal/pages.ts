import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type PagesDashboardMetric,
  type QueryAudience,
  scopedFilterMetadata,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildPagesPagePlan,
  buildTopPagesPlan,
  type PageAggregateCursor,
} from "@/lib/edge/analytics/engine/page-report-plan";
import {
  buildPagesWithTabsPlan,
  PAGES_WITH_TABS_OUTPUT_FIELDS,
  PAGES_WITH_TABS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import type { Env } from "@/lib/edge/types";

import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  DimensionRow,
  FilterDocument,
  Interval,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  PageRow,
  QueryWindow,
} from "./core";
import {
  appendSqlConditions,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { queryPageTabsFromD1, queryVisitDimensionFromD1 } from "./dimensions";
import { type PageDashboardCursor } from "./pages-dashboard";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";
import { scopedDatasetFor } from "./scoped-dataset";
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
export function pageCursorBinding(
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildTopPagesPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeDetails,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "top-pages",
  );
  return rows.map((row) => ({
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildPagesPagePlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeDetails,
    ...(cursor ? { cursor } : {}),
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "pages-page",
  );
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
 * Reads paginated Page rows and all five tabs from one Logical plan and D1
 * statement, keeping the regular pages query and its cursor contract intact.
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildPagesWithTabsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeDetails,
    ...(cursor ? { cursor } : {}),
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PAGES_WITH_TABS_OUTPUT_IDS,
    fields: PAGES_WITH_TABS_OUTPUT_FIELDS,
    orderBy: [
      { field: "rowType", direction: "asc", nulls: "first" },
      { field: "cardType", direction: "asc", nulls: "first" },
      { field: "views", direction: "desc", nulls: "last" },
      { field: "sessions", direction: "desc", nulls: "last" },
      { field: "pathname", direction: "asc", nulls: "first" },
      { field: "queryValue", direction: "asc", nulls: "first" },
      { field: "hashValue", direction: "asc", nulls: "first" },
      { field: "value", direction: "asc", nulls: "first" },
    ],
  });
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
export async function queryPageCardDetailsFromD1(
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
export async function queryDimensionAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selection: PageDimensionSelection,
  options?: { excludeEmpty?: boolean },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return queryVisitDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    selection,
    options,
    diagnostics,
  );
}
