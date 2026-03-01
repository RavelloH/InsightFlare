import { DEFAULT_EDGE_BASE_URL } from "./constants";

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

function adminToken(): string {
  return process.env.INSIGHTFLARE_ADMIN_API_TOKEN || "";
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
    const token = adminToken();
    if (token.length > 0) {
      headers.set("x-admin-token", token);
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

export interface TeamData {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: number;
  siteCount: number;
  memberCount: number;
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
  email: string;
  name: string | null;
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
  ownerEmail?: string;
  ownerName?: string;
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
  email: string;
  name?: string;
  role?: string;
}): Promise<MemberData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData }>({
    method: "POST",
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
