import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters } from "@/lib/dashboard/client/utils";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import type { ClientDimensionKey } from "@/lib/dashboard-api/client/edge";
import type {
  BrowserCrossBreakdownData,
  BrowserCrossBreakdownDimensionData,
  BrowserRadarData,
  BrowserTrendData,
  BrowserVersionBreakdownData,
  ClientCrossBreakdownData,
} from "@/lib/dashboard-api/client/edge";
import {
  attachFilterScopePreference,
  type FilterDocument,
} from "@/lib/filter-contract";
export async function fetchClientDimensionTrend(
  siteId: string,
  window: TimeWindow,
  dimension: ClientDimensionKey,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
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
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
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
    transport?: PrivateReadTransport;
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
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
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
    transport?: PrivateReadTransport;
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
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
  );
}
export async function fetchBrowserEngineTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
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
    {
      signal: options?.signal,
      ...(options?.transport ? { transport: options.transport } : {}),
    },
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
    transport?: PrivateReadTransport;
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
  return fetchPrivateJson<BrowserVersionBreakdownData>(
    "/api/private/browser-version-breakdown",
    requestParams,
    options?.signal || options?.transport
      ? {
          signal: options?.signal,
          ...(options?.transport ? { transport: options.transport } : {}),
        }
      : undefined,
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
    transport?: PrivateReadTransport;
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
  return fetchPrivateJson<BrowserCrossBreakdownData>(
    "/api/private/browser-cross-breakdown",
    requestParams,
    options?.signal || options?.transport
      ? {
          signal: options?.signal,
          ...(options?.transport ? { transport: options.transport } : {}),
        }
      : undefined,
  );
}
export async function fetchBrowserRadar(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal; transport?: PrivateReadTransport },
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
  return fetchPrivateJson<BrowserRadarData>(
    "/api/private/browser-radar",
    requestParams,
    options?.signal || options?.transport
      ? {
          signal: options?.signal,
          ...(options?.transport ? { transport: options.transport } : {}),
        }
      : undefined,
  );
}

export function fetchDeviceTypeTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
) {
  return fetchClientDimensionTrend(
    siteId,
    window,
    "deviceType",
    filters,
    options,
  );
}
export function fetchOperatingSystemTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
  },
) {
  return fetchClientDimensionTrend(
    siteId,
    window,
    "operatingSystem",
    filters,
    options,
  );
}
export function startTechnologyInitialReads(
  page: "browsers" | "devices",
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
  const ignore = (p: Promise<unknown>) => {
    void p.catch(() => undefined);
  };
  const startPeriod = (w: TimeWindow, f: FilterDocument) => {
    if (page === "browsers") {
      ignore(fetchBrowserTrend(siteId, w, f, { limit: 5, transport }));
      ignore(fetchBrowserEngineTrend(siteId, w, f, { limit: 5, transport }));
      ignore(fetchBrowserRadar(siteId, w, f, { transport }));
      ignore(
        fetchBrowserVersionBreakdown(siteId, w, f, {
          browserLimit: 0,
          versionLimit: 5,
          transport,
        }),
      );
      ignore(fetchBrowserCrossBreakdown(siteId, w, f, { transport }));
    } else {
      ignore(fetchDeviceTypeTrend(siteId, w, f, { limit: 5, transport }));
      ignore(fetchOperatingSystemTrend(siteId, w, f, { limit: 5, transport }));
      ignore(
        fetchClientDimensionTrend(siteId, w, "screenSize", f, {
          limit: 10,
          transport,
        }),
      );
      for (const secondary of ["browser", "operatingSystem"] as const)
        ignore(
          fetchClientCrossBreakdown(siteId, w, "deviceType", secondary, f, {
            primaryLimit: 5,
            secondaryLimit: 6,
            transport,
          }),
        );
    }
  };
  startPeriod(window, filters);
  if (comparison) startPeriod(comparison.window, comparison.filters);
  if (page === "browsers")
    ignore(
      fetchBrowserVersionBreakdown(siteId, window, filters, {
        browserLimit: 0,
        versionLimit: 0,
        transport,
      }),
    );
}
