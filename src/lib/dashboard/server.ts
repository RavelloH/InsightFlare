import "server-only";
import { cache } from "react";
import {
  type QueryFilters,
  fetchAdminMe,
  fetchPrivateCountries,
  fetchPrivateEventTypes,
  fetchPrivateOverviewClientTab,
  fetchAdminSites,
  fetchPrivateOverview,
  fetchPrivatePages,
  fetchPrivateReferrers,
  fetchPrivateTrend,
  fetchPrivateVisitors,
  type DimensionData,
  type OverviewData,
  type PagesData,
  type ReferrersData,
  type SiteData,
  type TeamData,
  type TrendData,
  type VisitorsData,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";

export type RangePreset = "24h" | "7d" | "30d" | "90d";

export interface TimeWindow {
  preset: RangePreset;
  from: number;
  to: number;
  interval: "hour" | "day";
}

export type DashboardFilters = QueryFilters;

export interface SiteWithSlug extends SiteData {
  slug: string;
}

export interface DashboardContext {
  user: {
    id: string;
    username: string;
    email: string;
    name: string;
    systemRole: "admin" | "user";
  };
  teams: TeamData[];
  activeTeam: TeamData;
  sites: SiteWithSlug[];
  activeSite: SiteWithSlug;
}

export interface DashboardTeamContext {
  user: {
    id: string;
    username: string;
    email: string;
    name: string;
    systemRole: "admin" | "user";
  };
  teams: TeamData[];
  activeTeam: TeamData;
  sites: SiteWithSlug[];
}

const RANGE_PRESETS: readonly RangePreset[] = ["24h", "7d", "30d", "90d"] as const;

function normalizeFilterValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function parseDashboardFilters(
  searchParams: Record<string, string | string[] | undefined>,
): DashboardFilters {
  return {
    country: normalizeFilterValue(searchParams.country),
    device: normalizeFilterValue(searchParams.device),
    browser: normalizeFilterValue(searchParams.browser),
    path: normalizeFilterValue(searchParams.path),
    title: normalizeFilterValue(searchParams.title),
    hostname: normalizeFilterValue(searchParams.hostname),
    entry: normalizeFilterValue(searchParams.entry),
    exit: normalizeFilterValue(searchParams.exit),
    sourceDomain: normalizeFilterValue(searchParams.sourceDomain),
    sourceLink: normalizeFilterValue(searchParams.sourceLink),
    clientBrowser: normalizeFilterValue(searchParams.clientBrowser),
    clientOsVersion: normalizeFilterValue(searchParams.clientOsVersion),
    clientDeviceType: normalizeFilterValue(searchParams.clientDeviceType),
    clientLanguage: normalizeFilterValue(searchParams.clientLanguage),
    clientScreenSize: normalizeFilterValue(searchParams.clientScreenSize),
    geo: normalizeFilterValue(searchParams.geo),
    geoContinent: normalizeFilterValue(searchParams.geoContinent),
    geoTimezone: normalizeFilterValue(searchParams.geoTimezone),
    geoOrganization: normalizeFilterValue(searchParams.geoOrganization),
  };
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getSiteSlug(site: SiteData): string {
  const primary = String(site.publicSlug || "").trim();
  const domain = String(site.domain || "").trim();
  const name = String(site.name || "").trim();
  const candidate = safeSlug(primary || domain || name);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function withSiteSlug(site: SiteData): SiteWithSlug {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}

export function resolveRangePreset(value: string | string[] | undefined): RangePreset {
  if (typeof value !== "string") return "7d";
  if (RANGE_PRESETS.includes(value as RangePreset)) {
    return value as RangePreset;
  }
  return "7d";
}

export function resolveTimeWindow(range: string | string[] | undefined, now = Date.now()): TimeWindow {
  const preset = resolveRangePreset(range);
  const to = now;

  if (preset === "24h") {
    return {
      preset,
      from: now - 24 * 60 * 60 * 1000,
      to,
      interval: "hour",
    };
  }

  if (preset === "30d") {
    return {
      preset,
      from: now - 30 * 24 * 60 * 60 * 1000,
      to,
      interval: "day",
    };
  }

  if (preset === "90d") {
    return {
      preset,
      from: now - 90 * 24 * 60 * 60 * 1000,
      to,
      interval: "day",
    };
  }

  return {
    preset: "7d",
    from: now - 7 * 24 * 60 * 60 * 1000,
    to,
    interval: "day",
  };
}

function findSiteBySlug(sites: SiteWithSlug[], siteSlug: string): SiteWithSlug | null {
  const bySlug = sites.find((site) => site.slug === siteSlug);
  if (bySlug) return bySlug;
  const byId = sites.find((site) => site.id === siteSlug);
  return byId ?? null;
}

const getMe = cache(async () => {
  try {
    return await fetchAdminMe();
  } catch {
    return null;
  }
});

export const getDashboardProfile = cache(async () => {
  return getMe();
});

const getSitesForTeam = cache(async (teamId: string): Promise<SiteWithSlug[]> => {
  try {
    const sites = await fetchAdminSites(teamId);
    return sites.map(withSiteSlug);
  } catch {
    return [];
  }
});

export const getDashboardTeamContext = cache(
  async (teamSlug: string): Promise<DashboardTeamContext | null> => {
    const me = await getMe();
    if (!me) return null;

    const activeTeam = me.teams.find((team) => team.slug === teamSlug);
    if (!activeTeam) return null;

    const sites = await getSitesForTeam(activeTeam.id);

    return {
      user: me.user,
      teams: me.teams,
      activeTeam,
      sites,
    };
  },
);

export const getTeamSiteContext = cache(async (teamSlug: string, siteSlug: string): Promise<DashboardContext | null> => {
  const teamContext = await getDashboardTeamContext(teamSlug);
  if (!teamContext) return null;

  const activeSite = findSiteBySlug(teamContext.sites, siteSlug);
  if (!activeSite) return null;

  return {
    user: teamContext.user,
    teams: teamContext.teams,
    activeTeam: teamContext.activeTeam,
    sites: teamContext.sites,
    activeSite,
  };
});

export const getDefaultTeamSite = cache(async (): Promise<{ teamSlug: string; siteSlug: string } | null> => {
  const me = await getMe();
  if (!me || me.teams.length === 0) return null;

  const firstTeam = me.teams[0];
  const sites = await getSitesForTeam(firstTeam.id);
  if (sites.length === 0) {
    return null;
  }

  return {
    teamSlug: firstTeam.slug,
    siteSlug: sites[0].slug,
  };
});

export const getTeamDefaultSite = cache(async (teamSlug: string): Promise<{ teamSlug: string; siteSlug: string } | null> => {
  const me = await getMe();
  if (!me) return null;

  const activeTeam = me.teams.find((team) => team.slug === teamSlug);
  if (!activeTeam) return null;

  const sites = await getSitesForTeam(activeTeam.id);
  if (sites.length === 0) return null;

  return {
    teamSlug: activeTeam.slug,
    siteSlug: sites[0].slug,
  };
});

export function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
  section?:
    | "realtime"
    | "pages"
    | "referrers"
    | "sessions"
    | "events"
    | "visitors"
    | "geo"
    | "devices"
    | "browsers"
    | "settings",
): string {
  const base = `/${locale}/app/${teamSlug}/${siteSlug}`;
  if (!section) return base;
  return `${base}/${section}`;
}

export function withRange(pathname: string, range: RangePreset): string {
  return `${pathname}?range=${range}`;
}

function applyFiltersToParams(params: URLSearchParams, filters?: DashboardFilters): URLSearchParams {
  if (!filters) return params;
  if (filters.country) params.set("country", filters.country);
  if (filters.device) params.set("device", filters.device);
  if (filters.browser) params.set("browser", filters.browser);
  if (filters.path) params.set("path", filters.path);
  if (filters.title) params.set("title", filters.title);
  if (filters.hostname) params.set("hostname", filters.hostname);
  if (filters.entry) params.set("entry", filters.entry);
  if (filters.exit) params.set("exit", filters.exit);
  if (filters.sourceDomain) params.set("sourceDomain", filters.sourceDomain);
  if (filters.sourceLink) params.set("sourceLink", filters.sourceLink);
  if (filters.clientBrowser) params.set("clientBrowser", filters.clientBrowser);
  if (filters.clientOsVersion) params.set("clientOsVersion", filters.clientOsVersion);
  if (filters.clientDeviceType) params.set("clientDeviceType", filters.clientDeviceType);
  if (filters.clientLanguage) params.set("clientLanguage", filters.clientLanguage);
  if (filters.clientScreenSize) params.set("clientScreenSize", filters.clientScreenSize);
  if (filters.geo) params.set("geo", filters.geo);
  if (filters.geoContinent) params.set("geoContinent", filters.geoContinent);
  if (filters.geoTimezone) params.set("geoTimezone", filters.geoTimezone);
  if (filters.geoOrganization) params.set("geoOrganization", filters.geoOrganization);
  return params;
}

export function withRangeAndFilters(
  pathname: string,
  range: RangePreset,
  filters?: DashboardFilters,
): string {
  const params = applyFiltersToParams(new URLSearchParams(), filters);
  params.set("range", range);
  return `${pathname}?${params.toString()}`;
}

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

function emptyTrend(interval: "hour" | "day"): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}

function emptyPages(): PagesData {
  return { ok: true, data: [] };
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

async function loadBrowserDimensionFromClientTab(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
  filters?: DashboardFilters;
}): Promise<DimensionData> {
  const payload = await fetchPrivateOverviewClientTab({
    siteId: params.siteId,
    from: params.from,
    to: params.to,
    tab: "browser",
    limit: params.limit,
    filters: params.filters,
  });

  return {
    ok: payload.ok,
    data: payload.data.map((item) => ({
      value: String(item.label ?? ""),
      views: Number(item.views ?? 0),
      sessions: Number(item.sessions ?? 0),
    })),
  };
}

export async function loadOverviewBundle(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
): Promise<{
  overview: OverviewData;
  previousOverview: OverviewData;
  trend: TrendData;
  pages: PagesData;
  referrers: ReferrersData;
  countries: DimensionData;
  browsers: DimensionData;
  eventTypes: DimensionData;
}> {
  const previousTo = Math.max(window.from - 1, 0);
  const previousFrom = Math.max(previousTo - (window.to - window.from), 0);

  const [overview, pages, referrers, countries, browsers, eventTypes] =
    await Promise.all([
      fetchPrivateOverview({
        siteId,
        from: window.from,
        to: window.to,
        filters,
        includeChange: true,
        includeDetail: true,
        interval: window.interval,
      }).catch(() => emptyOverview()),
      fetchPrivatePages({ siteId, from: window.from, to: window.to, filters }).catch(() => emptyPages()),
      fetchPrivateReferrers({ siteId, from: window.from, to: window.to, filters }).catch(() => emptyReferrers()),
      fetchPrivateCountries({ siteId, from: window.from, to: window.to, limit: 12, filters }).catch(() => emptyDimension()),
      loadBrowserDimensionFromClientTab({ siteId, from: window.from, to: window.to, limit: 12, filters }).catch(() => emptyDimension()),
      fetchPrivateEventTypes({ siteId, from: window.from, to: window.to, limit: 12, filters }).catch(() => emptyDimension()),
    ]);

  const trend = overview.detail
    ? {
      ok: overview.ok,
      interval: overview.detail.interval,
      data: overview.detail.data,
    }
    : await fetchPrivateTrend({
      siteId,
      from: window.from,
      to: window.to,
      interval: window.interval,
      filters,
    }).catch(() => emptyTrend(window.interval));

  const previousOverview = overview.previousData
    ? {
        ok: overview.ok,
        data: overview.previousData,
      }
    : await fetchPrivateOverview({
        siteId,
        from: previousFrom,
        to: previousTo,
        filters,
      }).catch(() => emptyOverview());

  return {
    overview,
    previousOverview,
    trend,
    pages,
    referrers,
    countries,
    browsers,
    eventTypes,
  };
}

export async function loadPages(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<PagesData> {
  return fetchPrivatePages({ siteId, from: window.from, to: window.to, filters }).catch(() => emptyPages());
}

export async function loadReferrers(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<ReferrersData> {
  return fetchPrivateReferrers({ siteId, from: window.from, to: window.to, filters }).catch(() => emptyReferrers());
}

export async function loadVisitors(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<VisitorsData> {
  return fetchPrivateVisitors({ siteId, from: window.from, to: window.to, limit: 100, filters }).catch(() => emptyVisitors());
}

export async function loadCountries(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateCountries({ siteId, from: window.from, to: window.to, limit: 100, filters }).catch(() => emptyDimension());
}

export async function loadBrowsers(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return loadBrowserDimensionFromClientTab({ siteId, from: window.from, to: window.to, limit: 100, filters }).catch(() => emptyDimension());
}

export async function loadEventTypes(siteId: string, window: TimeWindow, filters?: DashboardFilters): Promise<DimensionData> {
  return fetchPrivateEventTypes({ siteId, from: window.from, to: window.to, limit: 100, filters }).catch(() => emptyDimension());
}
