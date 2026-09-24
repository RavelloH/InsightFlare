import type {
  PagesDashboardReaderInput,
  PagesDashboardResult,
} from "@/lib/edge/analytics/contract";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type PagesDashboardMetric,
  type PagesDashboardSortBy,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  PageCardAggregateRow,
  PageCardTrendRow,
  QueryWindow,
} from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  emptyOverviewAggregateRow,
  mapPageCardMetrics,
  normalizePathname,
  percentChange,
  queryD1All,
  visitSourceBindings,
} from "./core";
import {
  pageCursorBinding,
  queryPageCardDetailsFromD1,
  queryPageCardMetricsFromD1,
} from "./pages";
import { decodePageCursor, encodePageCursor, hasExactKeys } from "./pagination";
import { scopedDatasetFor } from "./scoped-dataset";
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
