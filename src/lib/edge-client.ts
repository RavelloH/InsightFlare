import { DEFAULT_EDGE_BASE_URL } from "./constants";
import { getSessionToken } from "./auth";

type HttpMethod = "GET" | "POST" | "PATCH";

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

async function fetchEdgeJson<T>(options: FetchEdgeOptions): Promise<T> {
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

export interface OverviewData {
  ok: boolean;
  data: {
    views: number;
    sessions: number;
    visitors: number;
    bounces: number;
    totalDurationMs: number;
    avgDurationMs: number;
    bounceRate: number;
    approximateVisitors?: boolean;
  };
}

export interface TrendPoint {
  bucket: number;
  timestampMs: number;
  views: number;
  sessions: number;
  totalDurationMs: number;
  source: "detail" | "archive" | "mixed";
}

export interface TrendData {
  ok: boolean;
  interval: "hour" | "day";
  data: TrendPoint[];
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
}

export interface ReferrersData {
  ok: boolean;
  data: Array<{
    referrer: string;
    views: number;
    sessions: number;
  }>;
}

export interface SessionsData {
  ok: boolean;
  data: Array<{
    sessionId: string;
    visitorId: string;
    startedAt: number;
    endedAt: number;
    views: number;
    totalDurationMs: number;
    countries: number;
    entryPath: string;
    exitPath: string;
  }>;
}

export interface EventsData {
  ok: boolean;
  data: Array<{
    id: string;
    eventType: string;
    eventAt: number;
    pathname: string;
    queryString: string;
    hashFragment: string;
    title: string;
    hostname: string;
    referer: string;
    refererHost: string;
    visitorId: string;
    sessionId: string;
    durationMs: number;
    country: string;
    region: string;
    city: string;
    browser: string;
    os: string;
    deviceType: string;
    language: string;
    timezone: string;
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
    countries: number;
    latestPath: string;
  }>;
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
  data: Record<string, unknown>;
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
}): Promise<OverviewData> {
  return fetchEdgeJson<OverviewData>({
    path: "/api/private/overview",
    params,
  });
}

export async function fetchPrivateTrend(params: {
  siteId: string;
  from: number;
  to: number;
  interval?: "hour" | "day";
}): Promise<TrendData> {
  return fetchEdgeJson<TrendData>({
    path: "/api/private/trend",
    params: {
      interval: params.interval || "day",
      siteId: params.siteId,
      from: params.from,
      to: params.to,
    },
  });
}

export async function fetchPrivatePages(params: {
  siteId: string;
  from: number;
  to: number;
}): Promise<PagesData> {
  return fetchEdgeJson<PagesData>({
    path: "/api/private/pages",
    params: {
      ...params,
      limit: 8,
      details: 1,
    },
  });
}

export async function fetchPrivateReferrers(params: {
  siteId: string;
  from: number;
  to: number;
}): Promise<ReferrersData> {
  return fetchEdgeJson<ReferrersData>({
    path: "/api/private/referrers",
    params: {
      ...params,
      limit: 8,
      fullUrl: 1,
    },
  });
}

export async function fetchPrivateSessions(params: {
  siteId: string;
  from: number;
  to: number;
}): Promise<SessionsData> {
  return fetchEdgeJson<SessionsData>({
    path: "/api/private/sessions",
    params: {
      ...params,
      limit: 8,
    },
  });
}

export async function fetchPrivateEvents(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
}): Promise<EventsData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: Array<{
      id?: string;
      event_type?: string;
      event_at?: number;
      pathname?: string;
      query_string?: string;
      hash_fragment?: string;
      title?: string;
      hostname?: string;
      referer?: string;
      referer_host?: string;
      visitor_id?: string;
      session_id?: string;
      duration_ms?: number;
      country?: string;
      region?: string;
      city?: string;
      browser?: string;
      os?: string;
      device_type?: string;
      language?: string;
      timezone?: string;
    }>;
  }>({
    path: "/api/private/events",
    params: {
      siteId: params.siteId,
      from: params.from,
      to: params.to,
      limit: params.limit ?? 100,
    },
  });

  return {
    ok: res.ok,
    data: res.data.map((item) => ({
      id: String(item.id ?? ""),
      eventType: String(item.event_type ?? ""),
      eventAt: Number(item.event_at ?? 0),
      pathname: String(item.pathname ?? "/"),
      queryString: String(item.query_string ?? ""),
      hashFragment: String(item.hash_fragment ?? ""),
      title: String(item.title ?? ""),
      hostname: String(item.hostname ?? ""),
      referer: String(item.referer ?? ""),
      refererHost: String(item.referer_host ?? ""),
      visitorId: String(item.visitor_id ?? ""),
      sessionId: String(item.session_id ?? ""),
      durationMs: Number(item.duration_ms ?? 0),
      country: String(item.country ?? ""),
      region: String(item.region ?? ""),
      city: String(item.city ?? ""),
      browser: String(item.browser ?? ""),
      os: String(item.os ?? ""),
      deviceType: String(item.device_type ?? ""),
      language: String(item.language ?? ""),
      timezone: String(item.timezone ?? ""),
    })),
  };
}

export async function fetchPrivateVisitors(params: {
  siteId: string;
  from: number;
  to: number;
  limit?: number;
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
      countries?: number;
      latestPath?: string;
      latest_path?: string;
    }>;
  }>({
    path: "/api/private/visitors",
    params: {
      siteId: params.siteId,
      from: params.from,
      to: params.to,
      limit: params.limit ?? 100,
    },
  });

  return {
    ok: res.ok,
    data: res.data.map((item) => ({
      visitorId: String(item.visitorId ?? item.visitor_id ?? ""),
      firstSeenAt: Number(item.firstSeenAt ?? item.first_seen_at ?? 0),
      lastSeenAt: Number(item.lastSeenAt ?? item.last_seen_at ?? 0),
      views: Number(item.views ?? 0),
      sessions: Number(item.sessions ?? 0),
      countries: Number(item.countries ?? 0),
      latestPath: String(item.latestPath ?? item.latest_path ?? ""),
    })),
  };
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

export async function fetchAdminSiteConfig(siteId: string): Promise<Record<string, unknown>> {
  const res = await fetchEdgeJson<SiteConfigData>({
    path: "/api/private/admin/site-config",
    params: { siteId },
  });
  return res.data;
}

export async function upsertAdminSiteConfig(input: {
  siteId: string;
  config: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
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
