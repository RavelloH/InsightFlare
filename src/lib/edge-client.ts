import type { TeamRole } from "@/lib/dashboard/permissions";
import type {
  AccountUserData,
  MemberData,
  OverviewData,
  PagesData,
  QueryFilters,
  ReferrersData,
  ScriptSnippetData,
  SiteConfigData,
  SiteData,
  TeamData,
  TrendData,
} from "@/lib/edge-client-types";
import type { SiteScriptSettings } from "@/lib/site-settings";

import { getSessionToken } from "./auth";
import { DEFAULT_EDGE_BASE_URL } from "./constants";

export type * from "@/lib/edge-client-types";

type HttpMethod = "GET" | "POST" | "PATCH";

export interface PublicSiteData {
  id: string;
  slug: string;
  name: string;
  domain: string;
}

interface FetchEdgeOptions {
  method?: HttpMethod;
  path: string;
  params?: Record<string, string | number>;
  body?: unknown;
  isPublic?: boolean;
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
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
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
  if (filters.query) next.query = filters.query;
  if (filters.title) next.title = filters.title;
  if (filters.hostname) next.hostname = filters.hostname;
  if (filters.entry) next.entry = filters.entry;
  if (filters.exit) next.exit = filters.exit;
  if (filters.sourceDomain) next.sourceDomain = filters.sourceDomain;
  if (filters.sourceLink) next.sourceLink = filters.sourceLink;
  if (filters.clientBrowser) next.clientBrowser = filters.clientBrowser;
  if (filters.clientOsVersion) next.clientOsVersion = filters.clientOsVersion;
  if (filters.clientDeviceType)
    next.clientDeviceType = filters.clientDeviceType;
  if (filters.clientLanguage) next.clientLanguage = filters.clientLanguage;
  if (filters.clientScreenSize)
    next.clientScreenSize = filters.clientScreenSize;
  if (filters.geo) next.geo = filters.geo;
  if (filters.geoContinent) next.geoContinent = filters.geoContinent;
  if (filters.geoTimezone) next.geoTimezone = filters.geoTimezone;
  if (filters.geoOrganization) next.geoOrganization = filters.geoOrganization;
  if (filters.eventPayloadFilters?.length) {
    next.eventPayloadFilters = JSON.stringify(filters.eventPayloadFilters);
  }
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
    throw new Error(
      `Edge API failed (${res.status} ${method} ${url.pathname}): ${text}`,
    );
  }

  return (await res.json()) as T;
}

export async function fetchPublicOverview(
  slug: string,
  params: {
    from: number;
    to: number;
    filters?: QueryFilters;
  },
): Promise<OverviewData> {
  return fetchEdgeJson<OverviewData>({
    path: `/api/public/${encodeURIComponent(slug)}/overview`,
    params: withFilters(
      {
        from: params.from,
        to: params.to,
      },
      params.filters,
    ),
    isPublic: true,
  });
}

export async function fetchPublicSite(slug: string): Promise<PublicSiteData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: PublicSiteData }>({
    path: `/api/public/${encodeURIComponent(slug)}/site`,
    isPublic: true,
  });
  if (!res.ok || !res.data) {
    throw new Error("Public site not found");
  }
  return res.data;
}

export async function fetchPublicTrend(
  slug: string,
  params: {
    from: number;
    to: number;
    filters?: QueryFilters;
  },
): Promise<TrendData> {
  return fetchEdgeJson<TrendData>({
    path: `/api/public/${encodeURIComponent(slug)}/trend`,
    params: withFilters(
      {
        from: params.from,
        to: params.to,
        interval: "day",
      },
      params.filters,
    ),
    isPublic: true,
  });
}

export async function fetchPublicPages(
  slug: string,
  params: {
    from: number;
    to: number;
    filters?: QueryFilters;
  },
): Promise<PagesData> {
  return fetchEdgeJson<PagesData>({
    path: `/api/public/${encodeURIComponent(slug)}/pages`,
    params: withFilters(
      {
        from: params.from,
        to: params.to,
        limit: 8,
      },
      params.filters,
    ),
    isPublic: true,
  });
}

export async function fetchPublicReferrers(
  slug: string,
  params: {
    from: number;
    to: number;
    filters?: QueryFilters;
  },
): Promise<ReferrersData> {
  return fetchEdgeJson<ReferrersData>({
    path: `/api/public/${encodeURIComponent(slug)}/referrers`,
    params: withFilters(
      {
        from: params.from,
        to: params.to,
        limit: 8,
      },
      params.filters,
    ),
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
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { teamId: string; removed: boolean };
  }>({
    method: "PATCH",
    path: "/api/private/admin/teams",
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function transferAdminTeamOwner(input: {
  teamId: string;
  newOwnerUserId: string;
}): Promise<TeamData & { transferred: boolean }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: TeamData & { transferred: boolean };
  }>({
    method: "PATCH",
    path: "/api/private/admin/teams",
    body: {
      ...input,
      intent: "transfer_owner",
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
  role?: TeamRole;
}): Promise<MemberData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData }>({
    method: "POST",
    path: "/api/private/admin/members",
    body: input,
  });
  return res.data;
}

export async function updateAdminMemberRole(input: {
  teamId: string;
  userId: string;
  role: TeamRole;
}): Promise<{ teamId: string; userId: string; role: TeamRole }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { teamId: string; userId: string; role: TeamRole };
  }>({
    method: "PATCH",
    path: "/api/private/admin/members",
    body: { ...input, intent: "update_role" },
  });
  return res.data;
}

export async function removeAdminMember(input: {
  teamId: string;
  userId: string;
}): Promise<{ teamId: string; userId: string; removed: boolean }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { teamId: string; userId: string; removed: boolean };
  }>({
    method: "PATCH",
    path: "/api/private/admin/members",
    body: input,
  });
  return res.data;
}

export async function fetchAdminSiteConfig(
  siteId: string,
): Promise<SiteScriptSettings> {
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

export async function fetchAdminScriptSnippet(
  siteId: string,
): Promise<ScriptSnippetData["data"]> {
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
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { userId: string; removed: boolean };
  }>({
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
  currentPassword?: string;
  password?: string;
  timeZone?: string;
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "POST",
    path: "/api/private/admin/profile",
    body: input,
  });
  return res.data;
}
