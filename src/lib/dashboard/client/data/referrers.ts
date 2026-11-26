import { fetchOverviewSourceCardTab } from "@/lib/dashboard/client/data/tabs";
import type {
  DashboardListRequestOptions,
  PrivateReadTransport,
  UtmDimensionTab,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import {
  normalizePaginatedCollection,
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
  DimensionData,
  ReferrerChannelTrendData,
  ReferrerRadarData,
  ReferrersData,
  ReferrerSummaryData,
} from "@/lib/dashboard-api/client/edge";
import {
  attachFilterScopePreference,
  type FilterDocument,
} from "@/lib/filter-contract";
const utmPathMap: Record<UtmDimensionTab, string> = {
  source: "utm-source",
  medium: "utm-medium",
  campaign: "utm-campaign",
  term: "utm-term",
  content: "utm-content",
};
export async function fetchReferrers(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions & {
    fullUrl?: boolean;
  },
): Promise<ReferrersData> {
  return fetchPrivateJson<ReferrersData>(
    "/api/private/referrers",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
        ...(options?.sort ? { sort: options.sort } : {}),
        ...(options?.direction ? { direction: options.direction } : {}),
        fullUrl: options?.fullUrl ? 1 : 0,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}
export async function fetchReferrerSummary(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    topN?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
): Promise<ReferrerSummaryData> {
  return fetchPrivateJson<ReferrerSummaryData>(
    "/api/private/referrer-summary",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        topN: options?.topN ?? 5,
      },
      filters,
    ),
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  );
}
export async function fetchUtmDimension(
  siteId: string,
  window: TimeWindow,
  tab: UtmDimensionTab,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions,
): Promise<DimensionData["data"]> {
  const requestParams = withComparison(
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
          ...(options?.sort ? { sort: options.sort } : {}),
          ...(options?.direction ? { direction: options.direction } : {}),
        },
        options,
        20,
      ),
      filters,
    ),
    options?.comparison,
    {
      metric: options?.comparisonMetric,
      sortBy: options?.comparisonSortBy,
    },
  );
  const response = options?.signal
    ? fetchPrivateJson<DimensionData>(
        `/api/private/${utmPathMap[tab]}`,
        requestParams,
        {
          signal: options.signal,
        },
      )
    : fetchPrivateJson<DimensionData>(
        `/api/private/${utmPathMap[tab]}`,
        requestParams,
      );
  return response.then((payload) => normalizePaginatedCollection(payload.data));
}
export async function fetchUtmTrend(
  siteId: string,
  window: TimeWindow,
  tab: UtmDimensionTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>(
    "/api/private/utm-dimension-trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        dimension: tab,
        limit: options?.limit ?? 5,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}
export async function fetchReferrerTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>(
    "/api/private/referrer-dimension-trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        limit: options?.limit ?? 5,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}
export async function fetchReferrerAndChannelTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
): Promise<ReferrerChannelTrendData> {
  return fetchPrivateJson<ReferrerChannelTrendData>(
    "/api/private/referrer-channel-dimension-trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        limit: options?.limit ?? 5,
      },
      filters,
    ),
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  );
}
export async function fetchReferrerRadar(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
): Promise<ReferrerRadarData> {
  return fetchPrivateJson<ReferrerRadarData>(
    "/api/private/referrer-radar",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 24,
      },
      filters,
    ),
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  );
}

export const REFERRER_SUMMARY_TOP_N = 5;
export const REFERRER_TREND_LIMIT = 5;
export const REFERRER_RADAR_LIMIT = 24;
export const REFERRER_TABLE_LIMIT = 100;

/** Only the default domain/channel tabs are read. Links and metadata remain
 * lazy client requests; the reference period is independent for each chart. */
export function startReferrersInitialReads(
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
  const startPeriod = (
    requestedWindow: TimeWindow,
    requestedFilters: FilterDocument,
  ) => {
    ignore(
      fetchReferrerSummary(siteId, requestedWindow, requestedFilters, {
        topN: REFERRER_SUMMARY_TOP_N,
        transport,
      }),
    );
    ignore(
      fetchReferrerAndChannelTrend(siteId, requestedWindow, requestedFilters, {
        limit: REFERRER_TREND_LIMIT,
        transport,
      }),
    );
    ignore(
      fetchReferrerRadar(siteId, requestedWindow, requestedFilters, {
        limit: REFERRER_RADAR_LIMIT,
        transport,
      }),
    );
  };
  startPeriod(window, filters);
  if (comparison) startPeriod(comparison.window, comparison.filters);
  for (const tab of ["domain", "channel"] as const) {
    ignore(
      fetchOverviewSourceCardTab(siteId, window, tab, filters, {
        limit: REFERRER_TABLE_LIMIT,
        sort: "views",
        direction: "desc",
        comparison,
        comparisonMetric: "views",
        comparisonSortBy: comparison ? "current" : undefined,
        transport,
      }),
    );
  }
}
