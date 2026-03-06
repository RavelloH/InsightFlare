import type {
  DimensionData,
  OverviewData,
  OverviewClientDimensionTabsData as OverviewClientDimensionTabsResponse,
  OverviewGeoDimensionTabsData as OverviewGeoDimensionTabsResponse,
  PagesData,
  ReferrersData,
  TrendData,
  VisitorsData,
} from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";

export interface FilterOptions {
  countries: string[];
  devices: string[];
  browsers: string[];
  eventTypes: string[];
}

export interface OverviewBundle {
  overview: OverviewData;
  previousOverview: OverviewData;
  trend: TrendData;
}

export type PageCardTabsData = NonNullable<PagesData["tabs"]>;
export type OverviewClientDimensionTabsData =
  OverviewClientDimensionTabsResponse["tabs"];
export type OverviewGeoDimensionTabsData = OverviewGeoDimensionTabsResponse["tabs"];

function emptyOverview(): OverviewData {
  return {
    ok: true,
    data: {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
    },
  };
}

function emptyTrend(interval: TimeWindow["interval"]): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}

function emptyPages(): PagesData {
  return { ok: true, data: [] };
}

function emptyPageCardTabs(): PageCardTabsData {
  return {
    path: [],
    title: [],
    hostname: [],
    entry: [],
    exit: [],
  };
}

function emptyOverviewClientDimensionTabs(): OverviewClientDimensionTabsData {
  return {
    browser: [],
    osVersion: [],
    deviceType: [],
    language: [],
    screenSize: [],
  };
}

function emptyOverviewGeoDimensionTabs(): OverviewGeoDimensionTabsData {
  return {
    country: [],
    region: [],
    city: [],
    continent: [],
    timezone: [],
    organization: [],
  };
}

function emptyReferrers(): ReferrersData {
  return { ok: true, data: [] };
}

function emptyVisitors(): VisitorsData {
  return { ok: true, data: [] };
}

function emptyDimension(): DimensionData {
  return { ok: true, data: [] };
}

function withFilters(
  params: Record<string, string | number>,
  filters?: DashboardFilters,
): Record<string, string | number> {
  const next = { ...params };
  if (!filters) return next;
  if (filters.country) next.country = filters.country;
  if (filters.device) next.device = filters.device;
  if (filters.browser) next.browser = filters.browser;
  return next;
}

function toQueryString(params?: Record<string, string | number>): string {
  if (!params) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

async function fetchPrivateJson<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const res = await fetch(`${path}${toQueryString(params)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status} ${path}): ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchOverview(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    includeChange?: boolean;
    includeDetail?: boolean;
  },
): Promise<OverviewData> {
  return fetchPrivateJson<OverviewData>("/api/private/overview", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    ...(options?.includeChange ? { includeChange: 1 } : {}),
    ...(options?.includeDetail ? { includeDetail: 1, interval: window.interval } : {}),
  }, filters));
}

export async function fetchTrend(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
): Promise<TrendData> {
  return fetchPrivateJson<TrendData>("/api/private/trend", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    interval: window.interval,
  }, filters));
}

export async function fetchPages(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<PagesData> {
  return fetchPrivateJson<PagesData>("/api/private/pages", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
    details: 1,
  }, filters));
}

export async function fetchPageCardTabs(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
): Promise<PageCardTabsData> {
  const payload = await fetchPrivateJson<PagesData>("/api/private/pages", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
  return payload.tabs ?? emptyPageCardTabs();
}

export async function fetchReferrers(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    fullUrl?: boolean;
    limit?: number;
  },
): Promise<ReferrersData> {
  return fetchPrivateJson<ReferrersData>(
    "/api/private/referrers",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
        fullUrl: options?.fullUrl ? 1 : 0,
      },
      filters,
    ),
  );
}

export async function fetchOverviewClientDimensionTabs(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewClientDimensionTabsData> {
  const payload = await fetchPrivateJson<OverviewClientDimensionTabsResponse>(
    "/api/private/overview-client-dimensions",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  );
  return payload.tabs ?? emptyOverviewClientDimensionTabs();
}

export async function fetchOverviewGeoDimensionTabs(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewGeoDimensionTabsData> {
  const payload = await fetchPrivateJson<OverviewGeoDimensionTabsResponse>(
    "/api/private/overview-geo-dimensions",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  );
  return payload.tabs ?? emptyOverviewGeoDimensionTabs();
}

export async function fetchVisitors(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<VisitorsData> {
  return fetchPrivateJson<VisitorsData>("/api/private/visitors", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
}

export async function fetchCountries(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateJson<DimensionData>("/api/private/countries", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
}

export async function fetchDevices(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateJson<DimensionData>("/api/private/devices", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
}

export async function fetchBrowsers(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateJson<DimensionData>("/api/private/browsers", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
}

export async function fetchEventTypes(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateJson<DimensionData>("/api/private/event-types", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    limit: 100,
  }, filters));
}

export async function loadFilterOptions(siteId: string, window: TimeWindow): Promise<FilterOptions> {
  const [countries, devices, browsers, eventTypes] = await Promise.all([
    fetchCountries(siteId, window).catch(() => emptyDimension()),
    fetchDevices(siteId, window).catch(() => emptyDimension()),
    fetchBrowsers(siteId, window).catch(() => emptyDimension()),
    fetchEventTypes(siteId, window).catch(() => emptyDimension()),
  ]);

  const uniq = (values: string[]) =>
    Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))).sort();

  return {
    countries: uniq(countries.data.map((item) => item.value)),
    devices: uniq(devices.data.map((item) => item.value)),
    browsers: uniq(browsers.data.map((item) => item.value)),
    eventTypes: uniq(eventTypes.data.map((item) => item.value)),
  };
}

export async function loadOverviewBundle(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
): Promise<OverviewBundle> {
  const previousTo = Math.max(window.from - 1, 0);
  const previousFrom = Math.max(previousTo - (window.to - window.from), 0);
  const previousWindow: TimeWindow = {
    ...window,
    from: previousFrom,
    to: previousTo,
  };

  const overview = await fetchOverview(siteId, window, filters, {
    includeChange: true,
    includeDetail: true,
  }).catch(() => emptyOverview());

  const trend = overview.detail
    ? {
      ok: overview.ok,
      interval: overview.detail.interval,
      data: overview.detail.data,
    }
    : await fetchTrend(siteId, window, filters).catch(() => emptyTrend(window.interval));

  const previousOverview = overview.previousData
    ? {
        ok: overview.ok,
        data: overview.previousData,
      }
    : await fetchOverview(siteId, previousWindow, filters).catch(() => emptyOverview());

  return {
    overview,
    previousOverview,
    trend,
  };
}

export const emptyDimensionData = emptyDimension;
export const emptyPagesData = emptyPages;
export const emptyReferrersData = emptyReferrers;
export const emptyVisitorsData = emptyVisitors;
export const emptyPageCardTabsData = emptyPageCardTabs;
export const emptyOverviewClientDimensionTabsData =
  emptyOverviewClientDimensionTabs;
export const emptyOverviewGeoDimensionTabsData = emptyOverviewGeoDimensionTabs;
