import { DEFAULT_EDGE_BASE_URL } from "./constants";
import { getSessionToken } from "./auth";
import type { SiteScriptSettings } from "@/lib/site-settings";

type HttpMethod = "GET" | "POST" | "PATCH";

interface FetchEdgeOptions {
  method?: HttpMethod;
  path: string;
  params?: Record<string, string | number>;
  body?: unknown;
  isPublic?: boolean;
}

export interface QueryFilters {
  country?: string;
  device?: string;
  browser?: string;
  path?: string;
  title?: string;
  hostname?: string;
  entry?: string;
  exit?: string;
  sourceDomain?: string;
  sourceLink?: string;
  clientBrowser?: string;
  clientOsVersion?: string;
  clientDeviceType?: string;
  clientLanguage?: string;
  clientScreenSize?: string;
  geo?: string;
  geoContinent?: string;
  geoTimezone?: string;
  geoOrganization?: string;
}

async function edgeBaseUrl(): Promise<string> {
  const configured = (process.env.INSIGHTFLARE_EDGE_URL || "").trim();
  if (configured.length > 0) {
    return configured;
  }

  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("x-forwarded-host") || h.get("host");
    if (host) {
      const proto =
        h.get("x-forwarded-proto") ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Ignore when headers() is unavailable outside request scope.
  }

  return DEFAULT_EDGE_BASE_URL;
}

function withQuery(url: URL, params?: Record<string, string | number>): URL {
  if (!params) return url;
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function withFilters(
  params: Record<string, string | number>,
  filters?: QueryFilters,
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

async function fetchEdgeJson<T>(options: FetchEdgeOptions): Promise<T> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    return handleDemoRequest({
      path: options.path,
      method: options.method,
      params: options.params as Record<string, string | number> | undefined,
      body: options.body,
    }) as T;
  }
  const method = options.method || "GET";
  const baseUrl = await edgeBaseUrl();
  const url = withQuery(new URL(options.path, baseUrl), options.params);

  const headers = new Headers();
  if (!options.isPublic) {
    try {
      const sessionToken = await getSessionToken();
      if (sessionToken) {
        headers.set("authorization", `Bearer ${sessionToken}`);
      }
    } catch {
      // Ignore when session is unavailable outside request scope.
    }
  }
  if (method !== "GET") {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge API failed (${res.status} ${method} ${url.pathname}): ${text}`);
  }

  return (await res.json()) as T;
}

export interface OverviewMetrics {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors?: boolean;
}

export interface OverviewChangeRates {
  views: number | null;
  sessions: number | null;
  visitors: number | null;
  bounces: number | null;
  bounceRate: number | null;
  avgDurationMs: number | null;
}

export interface OverviewDetailPoint {
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  source: "detail" | "archive" | "mixed";
}

export interface OverviewDetailData {
  interval: "minute" | "hour" | "day" | "week" | "month";
  data: OverviewDetailPoint[];
}

export interface OverviewData {
  ok: boolean;
  data: OverviewMetrics;
  previousData?: OverviewMetrics;
  changeRates?: OverviewChangeRates;
  detail?: OverviewDetailData;
}

export interface TrendPoint {
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  source: "detail" | "archive" | "mixed";
}

export interface TrendData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  data: TrendPoint[];
}

export type ClientDimensionKey =
  | "browser"
  | "operatingSystem"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";

export interface BrowserTrendSeries {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
}

export interface BrowserTrendPoint {
  bucket: number;
  timestampMs: number;
  totalViews: number;
  totalVisitors: number;
  totalSessions: number;
  viewsBySeries: Record<string, number>;
  visitorsBySeries: Record<string, number>;
  sessionsBySeries: Record<string, number>;
}

export interface BrowserTrendData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  series: BrowserTrendSeries[];
  data: BrowserTrendPoint[];
}

export interface BrowserVersionSlice {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserVersionBreakdownBrowser {
  browser: string;
  views: number;
  visitors: number;
  sessions: number;
  versions: BrowserVersionSlice[];
}

export interface BrowserVersionBreakdownData {
  ok: boolean;
  data: BrowserVersionBreakdownBrowser[];
}

export interface BrowserCrossBreakdownItem {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserCrossBreakdownRow extends BrowserCrossBreakdownItem {
  cells: BrowserCrossBreakdownItem[];
}

export interface BrowserCrossBreakdownDimensionData {
  columns: BrowserCrossBreakdownItem[];
  rows: BrowserCrossBreakdownRow[];
  totalViews: number;
  totalVisitors: number;
  totalSessions: number;
}

export interface BrowserCrossBreakdownData {
  ok: boolean;
  operatingSystem: BrowserCrossBreakdownDimensionData;
  deviceType: BrowserCrossBreakdownDimensionData;
}

export interface BrowserRadarMetrics {
  /** Average session duration in ms */
  duration: number;
  /** Non-bounce rate (0..1) */
  engagement: number;
  /** Average pages per session */
  depth: number;
  /** Return visitor rate (0..1) */
  loyalty: number;
  /** Average sessions per visitor */
  frequency: number;
  /** Visitor share of total (0..1) */
  traffic: number;
}

export interface BrowserRadarItem {
  browser: string;
  visitors: number;
  sessions: number;
  metrics: BrowserRadarMetrics;
}

export interface BrowserRadarData {
  ok: boolean;
  data: BrowserRadarItem[];
}

export interface PagesData {
  ok: boolean;
  data: Array<{
    pathname: string;
    query?: string;
    hash?: string;
    views: number;
    sessions: number;
  }>;
  tabs?: {
    path: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    title: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    hostname: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    entry: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    exit: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
  };
}

export interface ReferrersData {
  ok: boolean;
  data: Array<{
    referrer: string;
    views: number;
    sessions: number;
  }>;
}

export interface VisitorsData {
  ok: boolean;
  data: Array<{
    visitorId: string;
    firstSeenAt: number;
    lastSeenAt: number;
    views: number;
    sessions: number;
  }>;
}

export interface DimensionData {
  ok: boolean;
  data: Array<{
    value: string;
    views: number;
    sessions: number;
  }>;
}

export interface OverviewClientDimensionTabsData {
  ok: boolean;
  tabs: {
    browser: Array<{ label: string; views: number; sessions: number }>;
    osVersion: Array<{ label: string; views: number; sessions: number }>;
    deviceType: Array<{ label: string; views: number; sessions: number }>;
    language: Array<{ label: string; views: number; sessions: number }>;
    screenSize: Array<{ label: string; views: number; sessions: number }>;
  };
}

export interface OverviewGeoDimensionTabsData {
  ok: boolean;
  tabs: {
    country: Array<{ label: string; views: number; sessions: number }>;
    region: Array<{ label: string; views: number; sessions: number }>;
    city: Array<{ label: string; views: number; sessions: number }>;
    continent: Array<{ label: string; views: number; sessions: number }>;
    timezone: Array<{ label: string; views: number; sessions: number }>;
    organization: Array<{ label: string; views: number; sessions: number }>;
  };
}

export interface OverviewGeoPointsData {
  ok: boolean;
  data: Array<{
    latitude: number;
    longitude: number;
    timestampMs: number;
    country: string;
    region?: string;
    regionCode?: string;
    city?: string;
  }>;
  countryCounts: Array<{
    country: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  regionCounts: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  cityCounts: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}

export interface OverviewTabData {
  ok: boolean;
  data: Array<{
    label: string;
    views: number;
    sessions: number;
  }>;
}

export interface OverviewGeoTabData {
  ok: boolean;
  data: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}

export interface DashboardFilterOption {
  value: string;
  label: string;
  group?: "country" | "region" | "city";
}

export interface DashboardFilterOptionsData {
  ok: boolean;
  data: DashboardFilterOption[];
}

export interface TeamData {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: number;
  updatedAt?: number;
  siteCount: number;
  memberCount: number;
  membershipRole?: string;
}

export interface SiteData {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  publicEnabled: number | boolean;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemberData {
  teamId: string;
  userId: string;
  role: string;
  joinedAt: number;
  username: string;
  email: string;
  name: string | null;
}

export interface AccountUserData {
  id: string;
  username: string;
  email: string;
  name: string;
  systemRole: "admin" | "user";
  createdAt: number;
  updatedAt: number;
  teamCount?: number;
  ownedTeamCount?: number;
}

export interface SiteConfigData {
  ok: boolean;
  data: SiteScriptSettings;
}

export interface ScriptSnippetData {
  ok: boolean;
  data: {
    siteId: string;
    src: string;
    snippet: string;
  };
}

export async function fetchPrivateOverview(params: {
  siteId: string;
  from: number;
  to: number;
  filters?: QueryFilters;
  includeChange?: boolean;
  includeDetail?: boolean;
  interval?: "minute" | "hour" | "day" | "week" | "month";
}): Promise<OverviewData> {
  return fetchEdgeJson<OverviewData>({
    path: "/api/private/overview",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        ...(params.includeChange ? { includeChange: 1 } : {}),
        ...(params.includeDetail ? { includeDetail: 1 } : {}),
        ...(params.interval ? { interval: params.interval } : {}),
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateTrend(params: {
  siteId: string;
  from: number;
  to: number;
  interval?: "minute" | "hour" | "day" | "week" | "month";
  filters?: QueryFilters;
}): Promise<TrendData> {
  return fetchEdgeJson<TrendData>({
    path: "/api/private/trend",
    params: withFilters(
      {
        interval: params.interval || "day",
        siteId: params.siteId,
        from: params.from,
        to: params.to,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivatePages(params: {
  siteId: string;
  from: number;
  to: number;
  filters?: QueryFilters;
}): Promise<PagesData> {
  return fetchEdgeJson<PagesData>({
    path: "/api/private/pages",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: 8,
        details: 1,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateReferrers(params: {
  siteId: string;
  from: number;
  to: number;
  filters?: QueryFilters;
}): Promise<ReferrersData> {
  return fetchEdgeJson<ReferrersData>({
    path: "/api/private/referrers",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: 8,
        fullUrl: 0,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateOverviewGeoPoints(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
  filters?: QueryFilters;
}): Promise<OverviewGeoPointsData> {
  return fetchEdgeJson<OverviewGeoPointsData>({
    path: "/api/private/overview-geo-points",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 5000,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateVisitors(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
  filters?: QueryFilters;
}): Promise<VisitorsData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: Array<{
      visitorId?: string;
      visitor_id?: string;
      firstSeenAt?: number;
      first_seen_at?: number;
      lastSeenAt?: number;
      last_seen_at?: number;
      views?: number;
      sessions?: number;
    }>;
  }>({
    path: "/api/private/visitors",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 100,
      },
      params.filters,
    ),
  });

  return {
    ok: res.ok,
    data: res.data.map((item) => ({
      visitorId: String(item.visitorId ?? item.visitor_id ?? ""),
      firstSeenAt: Number(item.firstSeenAt ?? item.first_seen_at ?? 0),
      lastSeenAt: Number(item.lastSeenAt ?? item.last_seen_at ?? 0),
      views: Number(item.views ?? 0),
      sessions: Number(item.sessions ?? 0),
    })),
  };
}

export async function fetchPrivateCountries(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
  filters?: QueryFilters;
}): Promise<DimensionData> {
  return fetchEdgeJson<DimensionData>({
    path: "/api/private/countries",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 20,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateClientDimensionTrend(params: {
  siteId: string;
  from: number;
  to: number;
  dimension: ClientDimensionKey;
  interval?: "minute" | "hour" | "day" | "week" | "month";
  filters?: QueryFilters;
  limit?: number;
}): Promise<BrowserTrendData> {
  return fetchEdgeJson<BrowserTrendData>({
    path: "/api/private/client-dimension-trend",
    params: withFilters(
      {
        interval: params.interval || "day",
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        dimension: params.dimension,
        limit: params.limit ?? 5,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateClientCrossBreakdown(params: {
  siteId: string;
  from: number;
  to: number;
  primaryDimension: ClientDimensionKey;
  secondaryDimension: ClientDimensionKey;
  filters?: QueryFilters;
  primaryLimit?: number;
  secondaryLimit?: number;
}): Promise<BrowserCrossBreakdownDimensionData> {
  return fetchEdgeJson<BrowserCrossBreakdownDimensionData>({
    path: "/api/private/client-cross-breakdown",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        primaryDimension: params.primaryDimension,
        secondaryDimension: params.secondaryDimension,
        primaryLimit: params.primaryLimit ?? 5,
        secondaryLimit: params.secondaryLimit ?? 6,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateBrowserTrend(params: {
  siteId: string;
  from: number;
  to: number;
  interval?: "minute" | "hour" | "day" | "week" | "month";
  filters?: QueryFilters;
  limit?: number;
}): Promise<BrowserTrendData> {
  return fetchEdgeJson<BrowserTrendData>({
    path: "/api/private/browser-trend",
    params: withFilters(
      {
        interval: params.interval || "day",
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 5,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateBrowserEngineTrend(params: {
  siteId: string;
  from: number;
  to: number;
  interval?: "minute" | "hour" | "day" | "week" | "month";
  filters?: QueryFilters;
  limit?: number;
}): Promise<BrowserTrendData> {
  return fetchEdgeJson<BrowserTrendData>({
    path: "/api/private/browser-engine-trend",
    params: withFilters(
      {
        interval: params.interval || "day",
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 5,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateBrowserVersionBreakdown(params: {
  siteId: string;
  from: number;
  to: number;
  filters?: QueryFilters;
  browserLimit?: number;
  versionLimit?: number;
}): Promise<BrowserVersionBreakdownData> {
  return fetchEdgeJson<BrowserVersionBreakdownData>({
    path: "/api/private/browser-version-breakdown",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        browserLimit: params.browserLimit ?? 0,
        versionLimit: params.versionLimit ?? 5,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateBrowserCrossBreakdown(params: {
  siteId: string;
  from: number;
  to: number;
  filters?: QueryFilters;
  browserLimit?: number;
  osLimit?: number;
  deviceTypeLimit?: number;
}): Promise<BrowserCrossBreakdownData> {
  return fetchEdgeJson<BrowserCrossBreakdownData>({
    path: "/api/private/browser-cross-breakdown",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        browserLimit: params.browserLimit ?? 8,
        osLimit: params.osLimit ?? 6,
        deviceTypeLimit: params.deviceTypeLimit ?? 5,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateOverviewClientTab(params: {
  siteId: string;
  from: number;
  to: number;
  tab: "browser" | "osVersion" | "deviceType" | "language" | "screenSize";
  limit?: number;
  filters?: QueryFilters;
}): Promise<OverviewTabData> {
  const pathByTab = {
    browser: "browser",
    osVersion: "os-version",
    deviceType: "device-type",
    language: "language",
    screenSize: "screen-size",
  } as const;

  return fetchEdgeJson<OverviewTabData>({
    path: `/api/private/overview-client-${pathByTab[params.tab]}`,
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 100,
      },
      params.filters,
    ),
  });
}

export async function fetchPrivateEventTypes(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
  filters?: QueryFilters;
}): Promise<DimensionData> {
  return fetchEdgeJson<DimensionData>({
    path: "/api/private/event-types",
    params: withFilters(
      {
        siteId: params.siteId,
        from: params.from,
        to: params.to,
        limit: params.limit ?? 20,
      },
      params.filters,
    ),
  });
}

export async function fetchPublicOverview(
  slug: string,
  params: {
    from: number;
    to: number;
  },
): Promise<OverviewData> {
  return fetchEdgeJson<OverviewData>({
    path: `/api/public/${encodeURIComponent(slug)}/overview`,
    params,
    isPublic: true,
  });
}

export async function fetchPublicTrend(
  slug: string,
  params: {
    from: number;
    to: number;
  },
): Promise<TrendData> {
  return fetchEdgeJson<TrendData>({
    path: `/api/public/${encodeURIComponent(slug)}/trend`,
    params: {
      ...params,
      interval: "day",
    },
    isPublic: true,
  });
}

export async function fetchPublicPages(
  slug: string,
  params: {
    from: number;
    to: number;
  },
): Promise<PagesData> {
  return fetchEdgeJson<PagesData>({
    path: `/api/public/${encodeURIComponent(slug)}/pages`,
    params: {
      ...params,
      limit: 8,
    },
    isPublic: true,
  });
}

export async function fetchPublicReferrers(
  slug: string,
  params: {
    from: number;
    to: number;
  },
): Promise<ReferrersData> {
  return fetchEdgeJson<ReferrersData>({
    path: `/api/public/${encodeURIComponent(slug)}/referrers`,
    params: {
      ...params,
      limit: 8,
    },
    isPublic: true,
  });
}

export async function fetchAdminTeams(userId?: string): Promise<TeamData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: TeamData[] }>({
    path: "/api/private/admin/teams",
    params: userId ? { userId } : undefined,
  });
  return res.data;
}

export async function createAdminTeam(input: {
  name: string;
  slug?: string;
}): Promise<TeamData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: TeamData }>({
    method: "POST",
    path: "/api/private/admin/teams",
    body: input,
  });
  return res.data;
}

export async function updateAdminTeam(input: {
  teamId: string;
  name?: string;
  slug?: string;
}): Promise<TeamData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: TeamData }>({
    method: "PATCH",
    path: "/api/private/admin/teams",
    body: input,
  });
  return res.data;
}

export async function removeAdminTeam(input: {
  teamId: string;
}): Promise<{ teamId: string; removed: boolean }> {
  const res = await fetchEdgeJson<{ ok: boolean; data: { teamId: string; removed: boolean } }>({
    method: "PATCH",
    path: "/api/private/admin/teams",
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function fetchAdminSites(teamId: string): Promise<SiteData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: SiteData[] }>({
    path: "/api/private/admin/sites",
    params: { teamId },
  });
  return res.data;
}

export async function createAdminSite(input: {
  teamId: string;
  name: string;
  domain: string;
  publicEnabled?: boolean;
  publicSlug?: string;
}): Promise<SiteData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: SiteData }>({
    method: "POST",
    path: "/api/private/admin/sites",
    body: input,
  });
  return res.data;
}

export async function updateAdminSite(input: {
  siteId: string;
  teamId?: string;
  name?: string;
  domain?: string;
  publicEnabled?: boolean;
  publicSlug?: string;
}): Promise<SiteData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: SiteData }>({
    method: "PATCH",
    path: "/api/private/admin/sites",
    body: input,
  });
  return res.data;
}

export async function removeAdminSite(input: {
  siteId: string;
}): Promise<{ siteId: string; teamId: string; removed: boolean }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { siteId: string; teamId: string; removed: boolean };
  }>({
    method: "PATCH",
    path: "/api/private/admin/sites",
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function fetchAdminMembers(teamId: string): Promise<MemberData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData[] }>({
    path: "/api/private/admin/members",
    params: { teamId },
  });
  return res.data;
}

export async function addAdminMember(input: {
  teamId: string;
  identifier: string;
  userId?: string;
}): Promise<MemberData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData }>({
    method: "POST",
    path: "/api/private/admin/members",
    body: input,
  });
  return res.data;
}

export async function removeAdminMember(input: {
  teamId: string;
  userId: string;
}): Promise<{ teamId: string; userId: string; removed: boolean }> {
  const res = await fetchEdgeJson<{ ok: boolean; data: { teamId: string; userId: string; removed: boolean } }>({
    method: "PATCH",
    path: "/api/private/admin/members",
    body: input,
  });
  return res.data;
}

export async function fetchAdminSiteConfig(siteId: string): Promise<SiteScriptSettings> {
  const res = await fetchEdgeJson<SiteConfigData>({
    path: "/api/private/admin/site-config",
    params: { siteId },
  });
  return res.data;
}

export async function upsertAdminSiteConfig(input: {
  siteId: string;
  config: SiteScriptSettings | Record<string, unknown>;
}): Promise<SiteScriptSettings> {
  const res = await fetchEdgeJson<SiteConfigData>({
    method: "POST",
    path: "/api/private/admin/site-config",
    body: input,
  });
  return res.data;
}

export async function fetchAdminScriptSnippet(siteId: string): Promise<ScriptSnippetData["data"]> {
  const res = await fetchEdgeJson<ScriptSnippetData>({
    path: "/api/private/admin/script-snippet",
    params: { siteId },
  });
  return res.data;
}

export async function loginAdminAccount(input: {
  username: string;
  password: string;
}): Promise<{
  user: AccountUserData;
  teams: TeamData[];
}> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: {
      user: AccountUserData;
      teams: TeamData[];
    };
  }>({
    method: "POST",
    path: "/api/private/admin/auth/login",
    body: input,
  });
  return res.data;
}

export async function fetchAdminMe(): Promise<{
  user: AccountUserData;
  teams: TeamData[];
}> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: {
      user: AccountUserData;
      teams: TeamData[];
    };
  }>({
    path: "/api/private/admin/auth/me",
  });
  return res.data;
}

export async function fetchAdminUsers(): Promise<AccountUserData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData[] }>({
    path: "/api/private/admin/users",
  });
  return res.data;
}

export async function createAdminUser(input: {
  username: string;
  email: string;
  name?: string;
  password: string;
  systemRole?: "admin" | "user";
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "POST",
    path: "/api/private/admin/users",
    body: input,
  });
  return res.data;
}

export async function updateAdminUser(input: {
  userId: string;
  username?: string;
  email?: string;
  name?: string;
  password?: string;
  systemRole?: "admin" | "user";
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "PATCH",
    path: "/api/private/admin/users",
    body: input,
  });
  return res.data;
}

export async function removeAdminUser(input: {
  userId: string;
}): Promise<{ userId: string; removed: boolean }> {
  const res = await fetchEdgeJson<{ ok: boolean; data: { userId: string; removed: boolean } }>({
    method: "PATCH",
    path: "/api/private/admin/users",
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function updateMyProfile(input: {
  username?: string;
  email?: string;
  name?: string;
  password?: string;
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "POST",
    path: "/api/private/admin/profile",
    body: input,
  });
  return res.data;
}
