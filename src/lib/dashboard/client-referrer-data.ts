import type {
  DashboardListRequestOptions,
  UtmDimensionTab,
} from "@/lib/dashboard/client-data-types";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserTrendData,
  DimensionData,
  ReferrerChannelTrendData,
  ReferrerRadarData,
  ReferrersData,
  ReferrerSummaryData,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";

import { fetchPrivateJson } from "./client-request";
import { normalizePaginatedCollection, withFilters } from "./client-utils";

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
  options?: { topN?: number; signal?: AbortSignal },
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
    { signal: options?.signal },
  );
}

export async function fetchUtmDimension(
  siteId: string,
  window: TimeWindow,
  tab: UtmDimensionTab,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<DimensionData["data"]> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      limit: 100,
    },
    filters,
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
    { signal: options?.signal },
  );
}

export async function fetchReferrerRadar(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
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
    { signal: options?.signal },
  );
}
