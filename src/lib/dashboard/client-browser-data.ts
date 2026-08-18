import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { ClientDimensionKey } from "@/lib/edge-client";
import type {
  BrowserCrossBreakdownData,
  BrowserCrossBreakdownDimensionData,
  BrowserRadarData,
  BrowserTrendData,
  BrowserVersionBreakdownData,
  ClientCrossBreakdownData,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";

import { fetchPrivateJson } from "./client-request";
import { withFilters } from "./client-utils";

export async function fetchClientDimensionTrend(
  siteId: string,
  window: TimeWindow,
  dimension: ClientDimensionKey,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>(
    "/api/private/client-dimension-trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        dimension,
        limit: options?.limit ?? 5,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}

export async function fetchClientCrossBreakdown(
  siteId: string,
  window: TimeWindow,
  primaryDimension: ClientDimensionKey,
  secondaryDimension: ClientDimensionKey,
  filters?: FilterDocument,
  options?: {
    primaryLimit?: number;
    secondaryLimit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserCrossBreakdownDimensionData> {
  const response = await fetchPrivateJson<ClientCrossBreakdownData>(
    "/api/private/client-cross-breakdown",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        primaryDimension,
        secondaryDimension,
        primaryLimit: options?.primaryLimit ?? 5,
        secondaryLimit: options?.secondaryLimit ?? 6,
      },
      filters,
    ),
    { signal: options?.signal },
  );
  return response.data;
}

export async function fetchBrowserTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>(
    "/api/private/browser-trend",
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

export async function fetchBrowserEngineTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>(
    "/api/private/browser-engine-trend",
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

export async function fetchBrowserVersionBreakdown(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    browserLimit?: number;
    versionLimit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserVersionBreakdownData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      browserLimit: options?.browserLimit ?? 0,
      versionLimit: options?.versionLimit ?? 5,
    },
    filters,
  );
  return options?.signal
    ? fetchPrivateJson<BrowserVersionBreakdownData>(
        "/api/private/browser-version-breakdown",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<BrowserVersionBreakdownData>(
        "/api/private/browser-version-breakdown",
        requestParams,
      );
}

export async function fetchBrowserCrossBreakdown(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    browserLimit?: number;
    osLimit?: number;
    deviceTypeLimit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserCrossBreakdownData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      browserLimit: options?.browserLimit ?? 8,
      osLimit: options?.osLimit ?? 6,
      deviceTypeLimit: options?.deviceTypeLimit ?? 5,
    },
    filters,
  );
  return options?.signal
    ? fetchPrivateJson<BrowserCrossBreakdownData>(
        "/api/private/browser-cross-breakdown",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<BrowserCrossBreakdownData>(
        "/api/private/browser-cross-breakdown",
        requestParams,
      );
}

export async function fetchBrowserRadar(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<BrowserRadarData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
    },
    filters,
  );
  return options?.signal
    ? fetchPrivateJson<BrowserRadarData>(
        "/api/private/browser-radar",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<BrowserRadarData>(
        "/api/private/browser-radar",
        requestParams,
      );
}
