import { fetchTrend } from "@/lib/dashboard/client/data/core";
import {
  emptyPageCardTabs,
  emptyTrend,
} from "@/lib/dashboard/client/data/empty";
import type {
  DashboardListRequestOptions,
  PageCardTabsData,
  PagesDashboardListRequestOptions,
  PrivateReadTransport,
  PrivateRequestParams,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import {
  withComparison,
  withFilters,
  withPagination,
} from "@/lib/dashboard/client/utils";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import type {
  BrowserTrendData,
  PagesDashboardData,
  PagesData,
} from "@/lib/dashboard-api/client/edge";
import {
  attachFilterScopePreference,
  type FilterDocument,
} from "@/lib/filter-contract";
function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}
export async function fetchPagesDashboard(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: PagesDashboardListRequestOptions,
): Promise<PagesDashboardData> {
  const params = withComparison(
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          interval: window.interval,
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
          ...(options?.sort ? { sort: options.sort } : {}),
          ...(options?.direction ? { direction: options.direction } : {}),
        },
        options,
        12,
      ),
      filters,
    ),
    options?.comparison,
    {
      metric: options?.comparisonMetric,
      sortBy: options?.comparisonSortBy,
    },
  );
  return fetchPrivateJson<PagesDashboardData>(
    "/api/private/pages-dashboard",
    params,
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  );
}
export async function fetchPagesShareTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
): Promise<BrowserTrendData> {
  const limit = Math.max(1, Math.min(options?.limit ?? 5, 12));
  const [payload, totalTrend] = await Promise.all([
    fetchPagesDashboard(siteId, window, filters, {
      limit,
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    }).catch((error) =>
      fallbackUnlessAborted(
        error,
        () =>
          ({
            ok: true,
            interval: window.interval,
            data: {
              items: [],
              pagination: {
                limit,
                returned: 0,
                hasMore: false,
                nextCursor: null,
              },
            },
          }) satisfies PagesDashboardData,
      ),
    ),
    fetchTrend(siteId, window, filters, {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    }).catch((error) =>
      fallbackUnlessAborted(error, () => emptyTrend(window.interval)),
    ),
  ]);

  const series: BrowserTrendData["series"] = payload.data.items.map(
    (item, index) => ({
      key: `page_${index}`,
      label: item.pathname,
      views: item.metrics.views,
      visitors: item.metrics.views,
      sessions: item.metrics.sessions,
    }),
  );

  const pointByTimestamp = new Map<
    number,
    {
      timestampMs: number;
      totalVisitors: number;
      visitorsBySeries: Record<string, number>;
    }
  >();

  for (const [index, item] of payload.data.items.entries()) {
    const seriesKey = `page_${index}`;
    for (const point of item.trend) {
      const timestampMs = Number(point.timestampMs ?? 0);
      const value = Math.max(0, Number(point.views ?? 0));
      const current = pointByTimestamp.get(timestampMs) ?? {
        timestampMs,
        totalVisitors: 0,
        visitorsBySeries: {},
      };
      current.totalVisitors += value;
      current.visitorsBySeries[seriesKey] = value;
      pointByTimestamp.set(timestampMs, current);
    }
  }

  for (const point of totalTrend.data) {
    const timestampMs = Number(point.timestampMs ?? 0);
    const totalVisitors = Math.max(0, Number(point.views ?? 0));
    const current = pointByTimestamp.get(timestampMs) ?? {
      timestampMs,
      totalVisitors: 0,
      visitorsBySeries: {},
    };
    current.totalVisitors = Math.max(current.totalVisitors, totalVisitors);
    pointByTimestamp.set(timestampMs, current);
  }

  let otherViews = 0;
  let otherVisitors = 0;
  let otherSessions = 0;

  for (const point of pointByTimestamp.values()) {
    const topSeriesTotal = Object.values(point.visitorsBySeries).reduce(
      (sum, value) => sum + Math.max(0, Number(value ?? 0)),
      0,
    );
    const otherValue = Math.max(0, point.totalVisitors - topSeriesTotal);
    if (otherValue <= 0) continue;
    point.visitorsBySeries.other = otherValue;
    otherViews += otherValue;
    otherVisitors += otherValue;
    otherSessions += otherValue;
  }

  if (otherVisitors > 0) {
    series.push({
      key: "other",
      label: "Other",
      views: otherViews,
      visitors: otherVisitors,
      sessions: otherSessions,
      isOther: true,
    });
  }

  const data = [...pointByTimestamp.values()]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((point, index) => ({
      bucket: index,
      timestampMs: point.timestampMs,
      totalVisitors: point.totalVisitors,
      visitorsBySeries: point.visitorsBySeries,
    }));

  return {
    ok: payload.ok,
    interval: payload.interval,
    series,
    data,
  };
}
export async function fetchPageCardTabs(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions,
): Promise<PageCardTabsData> {
  const payload = await fetchPrivateJson<PagesData>(
    "/api/private/pages",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      },
      filters,
    ) satisfies PrivateRequestParams,
    { signal: options?.signal },
  );
  return payload.tabs ?? emptyPageCardTabs();
}

export const PAGE_LIST_PAGE_SIZE = 25;
export const PAGE_SHARE_TREND_LIMIT = 5;

export function resolvePagesListComparisonQuery(
  search: URLSearchParams,
  window: TimeWindow,
  filters: FilterDocument,
) {
  return (
    resolveDashboardComparisonQuery(search, window, filters) ??
    resolveDashboardComparisonQuery(
      new URLSearchParams("compare=previous"),
      window,
      filters,
    )
  );
}

/** The table has an implicit previous-period comparison; the chart does not.
 * Preserve both request identities and let the table and chart resolve independently. */
export function startPagesInitialReads(
  siteId: string,
  window: TimeWindow,
  search: URLSearchParams,
  transport: PrivateReadTransport,
): void {
  const document = parseFilterDocumentFromSearchParams(search);
  const filters = document.root
    ? document
    : attachFilterScopePreference(document, "auto");
  const comparison = resolveDashboardComparisonQuery(search, window, filters);
  const ignore = (promise: Promise<unknown>) => {
    void promise.catch(() => undefined);
  };
  ignore(
    fetchPagesDashboard(siteId, window, filters, {
      limit: PAGE_LIST_PAGE_SIZE,
      sort: "views",
      direction: "desc",
      comparison: resolvePagesListComparisonQuery(search, window, filters),
      comparisonMetric: "views",
      comparisonSortBy: "current",
      transport,
    }),
  );
  // Plan the raw reads, not the derived share-series transformation; the
  // existing client queryFn computes the series once from these responses.
  const startTrendReads = (
    requestedWindow: TimeWindow,
    requestedFilters: FilterDocument,
  ) => {
    ignore(
      fetchPagesDashboard(siteId, requestedWindow, requestedFilters, {
        limit: PAGE_SHARE_TREND_LIMIT,
        transport,
      }),
    );
    ignore(
      fetchTrend(siteId, requestedWindow, requestedFilters, { transport }),
    );
  };
  startTrendReads(window, filters);
  if (comparison) startTrendReads(comparison.window, comparison.filters);
}
