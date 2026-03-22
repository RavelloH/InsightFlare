import type {
  BrowserCrossBreakdownData,
  BrowserCrossBreakdownDimensionData,
  BrowserVersionBreakdownData,
  BrowserTrendData,
  ClientDimensionKey,
  DashboardFilterOption,
  DashboardFilterOptionsData,
  DimensionData,
  OverviewData,
  OverviewGeoTabData,
  OverviewTabData,
  OverviewClientDimensionTabsData as OverviewClientDimensionTabsResponse,
  OverviewGeoDimensionTabsData as OverviewGeoDimensionTabsResponse,
  OverviewGeoPointsData,
  PagesData,
  ReferrersData,
  TrendData,
  VisitorsData,
} from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";

export type DashboardFilterOptionData = DashboardFilterOption;

export interface OverviewBundle {
  overview: OverviewData;
  previousOverview: OverviewData;
  trend: TrendData;
}

export type PageCardTabsData = NonNullable<PagesData["tabs"]>;
export type OverviewClientDimensionTabsData =
  OverviewClientDimensionTabsResponse["tabs"];
export type OverviewGeoDimensionTabsData = OverviewGeoDimensionTabsResponse["tabs"];
export type OverviewTabRows = OverviewTabData["data"];
export type OverviewGeoTabRows = Array<{
  value: string;
  label: string;
  views: number;
  sessions: number;
}>;

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

function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
    regionCounts: [],
    cityCounts: [],
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

function emptyOverviewTab(): OverviewTabData {
  return { ok: true, data: [] };
}

function emptyOverviewGeoTab(): OverviewGeoTabData {
  return { ok: true, data: [] };
}

function emptyDashboardFilterOptions(): DashboardFilterOptionsData {
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
  if (filters.path) next.path = filters.path;
  if (filters.title) next.title = filters.title;
  if (filters.hostname) next.hostname = filters.hostname;
  if (filters.entry) next.entry = filters.entry;
  if (filters.exit) next.exit = filters.exit;
  if (filters.sourceDomain) next.sourceDomain = filters.sourceDomain;
  if (filters.sourceLink) next.sourceLink = filters.sourceLink;
  if (filters.clientBrowser) next.clientBrowser = filters.clientBrowser;
  if (filters.clientOsVersion) next.clientOsVersion = filters.clientOsVersion;
  if (filters.clientDeviceType) next.clientDeviceType = filters.clientDeviceType;
  if (filters.clientLanguage) next.clientLanguage = filters.clientLanguage;
  if (filters.clientScreenSize) next.clientScreenSize = filters.clientScreenSize;
  if (filters.geo) next.geo = filters.geo;
  if (filters.geoContinent) next.geoContinent = filters.geoContinent;
  if (filters.geoTimezone) next.geoTimezone = filters.geoTimezone;
  if (filters.geoOrganization) next.geoOrganization = filters.geoOrganization;
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
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    return handleDemoRequest({ path, params }) as T;
  }
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

export async function fetchOverviewGeoPoints(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
    applyGeoFilter?: boolean;
  },
): Promise<OverviewGeoPointsData> {
  return fetchPrivateJson<OverviewGeoPointsData>(
    "/api/private/overview-geo-points",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 5000,
        ...(options?.applyGeoFilter ? { applyGeoFilter: 1 } : {}),
      },
      filters,
    ),
  )
    .then((payload) => ({
      ok: payload.ok,
      data: Array.isArray(payload.data)
        ? payload.data.map((row) => ({
            latitude: Number((row as { latitude?: unknown }).latitude ?? 0),
            longitude: Number((row as { longitude?: unknown }).longitude ?? 0),
            timestampMs: Number((row as { timestampMs?: unknown }).timestampMs ?? 0),
            country: String((row as { country?: unknown }).country ?? ""),
            region: String((row as { region?: unknown }).region ?? ""),
            regionCode: String((row as { regionCode?: unknown }).regionCode ?? ""),
            city: String((row as { city?: unknown }).city ?? ""),
          }))
        : [],
      countryCounts: Array.isArray(payload.countryCounts)
        ? payload.countryCounts.map((row) => ({
            country: String((row as { country?: unknown }).country ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
      regionCounts: Array.isArray(payload.regionCounts)
        ? payload.regionCounts.map((row) => ({
            value: String((row as { value?: unknown }).value ?? ""),
            label: String((row as { label?: unknown }).label ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
      cityCounts: Array.isArray(payload.cityCounts)
        ? payload.cityCounts.map((row) => ({
            value: String((row as { value?: unknown }).value ?? ""),
            label: String((row as { label?: unknown }).label ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
    }))
    .catch(() => emptyOverviewGeoPoints());
}

export async function fetchOverviewPageCardTab(
  siteId: string,
  window: TimeWindow,
  tab: "path" | "title" | "hostname" | "entry" | "exit",
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-page-${tab}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewTab());
  return payload.data ?? [];
}

export async function fetchOverviewSourceCardTab(
  siteId: string,
  window: TimeWindow,
  tab: "domain" | "link",
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-source-${tab}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewTab());
  return payload.data ?? [];
}

export async function fetchOverviewClientDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab: "browser" | "osVersion" | "deviceType" | "language" | "screenSize",
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  const pathByTab = {
    browser: "browser",
    osVersion: "os-version",
    deviceType: "device-type",
    language: "language",
    screenSize: "screen-size",
  } as const;
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-client-${pathByTab[tab]}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewTab());
  return payload.data ?? [];
}

export async function fetchOverviewGeoDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab:
    | "country"
    | "region"
    | "city"
    | "continent"
    | "timezone"
    | "organization",
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewGeoTabRows> {
  const payload = await fetchPrivateJson<OverviewGeoTabData>(
    `/api/private/overview-geo-${tab}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewGeoTab());
  return Array.isArray(payload.data)
    ? payload.data.map((row) => ({
        value:
          String((row as { value?: unknown }).value ?? "").trim() ||
          String((row as { label?: unknown }).label ?? "").trim(),
        label:
          tab === "region"
            ? (
                String((row as { label?: unknown }).label ?? "").trim() ||
                String((row as { value?: unknown }).value ?? "").trim()
              )
                .split("::")
                .map((segment) => segment.trim())
                .filter((segment) => segment.length > 0)[2] ||
              String((row as { label?: unknown }).label ?? "").trim() ||
              String((row as { value?: unknown }).value ?? "").trim()
            : tab === "city"
              ? (
                  String((row as { label?: unknown }).label ?? "").trim() ||
                  String((row as { value?: unknown }).value ?? "").trim()
                )
                  .split("::")
                  .map((segment) => segment.trim())
                  .filter((segment) => segment.length > 0)[3] ||
                String((row as { label?: unknown }).label ?? "").trim() ||
                String((row as { value?: unknown }).value ?? "").trim()
              : String((row as { label?: unknown }).label ?? "").trim() ||
                String((row as { value?: unknown }).value ?? "").trim(),
        views: Number((row as { views?: unknown }).views ?? 0),
        sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
      }))
    : [];
}

export async function fetchDashboardFilterOptions(
  siteId: string,
  window: TimeWindow,
  filterKey: keyof DashboardFilters,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<DashboardFilterOptionData[]> {
  const payload = await fetchPrivateJson<DashboardFilterOptionsData>(
    "/api/private/filter-options",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        filterKey,
        limit: options?.limit ?? 200,
      },
      filters,
    ),
  ).catch(() => emptyDashboardFilterOptions());
  return Array.isArray(payload.data) ? payload.data : [];
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

export async function fetchClientDimensionTrend(
  siteId: string,
  window: TimeWindow,
  dimension: ClientDimensionKey,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>("/api/private/client-dimension-trend", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    interval: window.interval,
    dimension,
    limit: options?.limit ?? 5,
  }, filters));
}

export async function fetchClientCrossBreakdown(
  siteId: string,
  window: TimeWindow,
  primaryDimension: ClientDimensionKey,
  secondaryDimension: ClientDimensionKey,
  filters?: DashboardFilters,
  options?: {
    primaryLimit?: number;
    secondaryLimit?: number;
  },
): Promise<BrowserCrossBreakdownDimensionData> {
  return fetchPrivateJson<BrowserCrossBreakdownDimensionData>(
    "/api/private/client-cross-breakdown",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        primaryDimension,
        secondaryDimension,
        primaryLimit: options?.primaryLimit ?? 5,
        secondaryLimit: options?.secondaryLimit ?? 6,
      },
      filters,
    ),
  );
}

export async function fetchBrowserTrend(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>("/api/private/browser-trend", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    interval: window.interval,
    limit: options?.limit ?? 5,
  }, filters));
}

export async function fetchBrowserEngineTrend(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<BrowserTrendData> {
  return fetchPrivateJson<BrowserTrendData>("/api/private/browser-engine-trend", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    interval: window.interval,
    limit: options?.limit ?? 5,
  }, filters));
}

export async function fetchBrowserVersionBreakdown(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    browserLimit?: number;
    versionLimit?: number;
  },
): Promise<BrowserVersionBreakdownData> {
  return fetchPrivateJson<BrowserVersionBreakdownData>("/api/private/browser-version-breakdown", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    browserLimit: options?.browserLimit ?? 0,
    versionLimit: options?.versionLimit ?? 5,
  }, filters));
}

export async function fetchBrowserCrossBreakdown(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    browserLimit?: number;
    osLimit?: number;
    deviceTypeLimit?: number;
  },
): Promise<BrowserCrossBreakdownData> {
  return fetchPrivateJson<BrowserCrossBreakdownData>("/api/private/browser-cross-breakdown", withFilters({
    siteId,
    from: window.from,
    to: window.to,
    browserLimit: options?.browserLimit ?? 8,
    osLimit: options?.osLimit ?? 6,
    deviceTypeLimit: options?.deviceTypeLimit ?? 5,
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
export const emptyOverviewGeoPointsData = emptyOverviewGeoPoints;
