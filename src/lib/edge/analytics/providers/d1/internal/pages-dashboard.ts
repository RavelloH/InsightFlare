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
  scopedFilterMetadata,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildPagesDashboardComparisonPlan,
  PAGES_DASHBOARD_COMPARISON_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/pages-dashboard-comparison-report-plan";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  Interval,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  QueryWindow,
} from "./core";
import {
  emptyOverviewAggregateRow,
  mapPageCardMetrics,
  normalizePathname,
  percentChange,
} from "./core";
import {
  pageCursorBinding,
  queryPageCardDetailsFromD1,
  queryPageCardMetricsFromD1,
} from "./pages";
import { decodePageCursor, encodePageCursor, hasExactKeys } from "./pagination";
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
export async function pagesDashboardCursorBinding(
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
export function pageDashboardCursor(
  value: unknown,
): PageDashboardCursor | null {
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

export interface PagesDashboardResultRows {
  readonly interval: Interval;
  readonly limit: number;
  readonly currentRows: readonly PageCardAggregateRow[];
  readonly previousRows: readonly PageCardAggregateRow[];
  readonly details: {
    readonly titles: readonly PageCardTitleRow[];
    readonly trend: readonly PageCardTrendRow[];
  };
  readonly comparisonDetails?: {
    readonly titles: readonly PageCardTitleRow[];
    readonly trend: readonly PageCardTrendRow[];
  };
  readonly comparison?: boolean;
  readonly referenceByPath?: ReadonlyMap<string, PageCardAggregateRow>;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** Shared public DTO mapper for the legacy reader and qualified raw rows. */
export function mapPagesDashboardResultRows(
  input: PagesDashboardResultRows,
): PagesDashboardResult {
  const {
    currentRows,
    previousRows,
    details,
    comparisonDetails = { titles: [], trend: [] },
    comparison = false,
    referenceByPath = new Map<string, PageCardAggregateRow>(),
  } = input;
  if (currentRows.length === 0) {
    return {
      interval: input.interval,
      items: [],
      pagination: {
        limit: input.limit,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const previousByPath = new Map<string, PageCardAggregateRow>();
  for (const row of previousRows) previousByPath.set(row.pathname, row);
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
    interval: input.interval,
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
      limit: input.limit,
      returned: currentRows.length,
      hasMore: input.hasMore,
      nextCursor: input.nextCursor,
    },
  };
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
  const currentMetadata = scopedFilterMetadata(currentFilters);
  const referenceMetadata = scopedFilterMetadata(referenceFilters);
  const plan = buildPagesDashboardComparisonPlan({
    current: {
      siteId,
      queryTime: queryWindowToTime(current),
      filters: currentFilters,
      ...(currentMetadata
        ? {
            scopePlan: currentMetadata.plan,
            preparedTimePolicy: "reader-window-v1" as const,
          }
        : {}),
    },
    reference: {
      siteId,
      queryTime: queryWindowToTime(reference),
      filters: referenceFilters,
      ...(referenceMetadata
        ? {
            scopePlan: referenceMetadata.plan,
            preparedTimePolicy: "reader-window-v1" as const,
          }
        : {}),
    },
    ...options,
    limit,
    cursor,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PAGES_DASHBOARD_COMPARISON_OUTPUT_ID,
  );
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

  return mapPagesDashboardResultRows({
    interval,
    limit: page.limit,
    currentRows,
    previousRows,
    details,
    comparisonDetails,
    comparison: Boolean(comparison),
    referenceByPath,
    hasMore,
    nextCursor,
  });
}
