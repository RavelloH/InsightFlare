import { adminServicePath } from "@/lib/admin-service-contract";
import type { TeamRole } from "@/lib/dashboard/permissions";
import type {
  AccountUserData,
  MemberData,
  NotificationMessageData,
  NotificationRuleData,
  NotificationRuleEvaluationData,
  NotificationRuleRunData,
  OverviewData,
  PagesData,
  QueryFilters,
  ReferrersData,
  ScriptSnippetData,
  SessionTeamGroups,
  SiteConfigData,
  SiteData,
  TeamData,
  TrendData,
} from "@/lib/edge-client-types";
import {
  analyticsFilterRegistry,
  serializeFilterParams,
} from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { PublicNotificationEmailConfig } from "@/lib/notifications/email-config";
import type { SiteScriptSettings } from "@/lib/site-settings";

import { getSessionToken } from "./auth";
import { DEFAULT_EDGE_BASE_URL } from "./constants";
import { requestHeader } from "./request-headers";

export type * from "@/lib/edge-client-types";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface PublicSiteData {
  id: string;
  slug: string;
  name: string;
  domain: string;
}

export interface FetchEdgeOptions {
  method?: HttpMethod;
  path: string;
  params?: Record<string, string | number>;
  body?: unknown;
  isPublic?: boolean;
  signal?: AbortSignal;
}

async function edgeBaseUrl(): Promise<string> {
  if (
    typeof window !== "undefined" &&
    process.env.VITEST !== "true" &&
    !window.navigator.userAgent.toLowerCase().includes("jsdom")
  ) {
    return window.location.origin;
  }

  try {
    const host =
      (await requestHeader("x-forwarded-host")) ||
      (await requestHeader("host"));
    if (host) {
      const proto =
        (await requestHeader("x-forwarded-proto")) ||
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
  for (const [key, value] of serializeFilterParams(
    filters,
    analyticsFilterRegistry,
  )) {
    next[key] = value;
  }
  return next;
}

export async function fetchEdgeJson<T>(options: FetchEdgeOptions): Promise<T> {
  const method = options.method || "GET";
  const baseUrl = await edgeBaseUrl();
  const url = withQuery(new URL(options.path, baseUrl), options.params);

  const headers = new Headers();
  if (options.isPublic) {
    headers.set("x-requested-with", "fetch");
    if (typeof window === "undefined") {
      headers.set(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      );
      headers.set("referer", `${url.origin}/`);
    }
  } else {
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
    signal: options.signal,
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
    path: `/api/public/share/${encodeURIComponent(slug)}/overview`,
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
    path: `/api/public/share/${encodeURIComponent(slug)}/site`,
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
    path: `/api/public/share/${encodeURIComponent(slug)}/trend`,
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
    path: `/api/public/share/${encodeURIComponent(slug)}/pages`,
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
    path: `/api/public/share/${encodeURIComponent(slug)}/referrers`,
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
    path: adminServicePath("teams"),
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
    path: adminServicePath("teams"),
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
    path: adminServicePath("teams"),
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
    path: adminServicePath("teams"),
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
    path: adminServicePath("teams"),
    body: {
      ...input,
      intent: "transfer_owner",
    },
  });
  return res.data;
}

export async function fetchAdminSites(
  teamId: string,
  options?: { signal?: AbortSignal },
): Promise<SiteData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: SiteData[] }>({
    path: adminServicePath("sites"),
    params: { teamId },
    signal: options?.signal,
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
    path: adminServicePath("sites"),
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
    path: adminServicePath("sites"),
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
    path: adminServicePath("sites"),
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function fetchAdminMembers(
  teamId: string,
  options?: { signal?: AbortSignal },
): Promise<MemberData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData[] }>({
    path: adminServicePath("members"),
    params: { teamId },
    signal: options?.signal,
  });
  return res.data;
}

export async function addAdminMember(input: {
  teamId: string;
  identifier: string;
  userId?: string;
  role?: TeamRole;
  siteIds?: string[];
}): Promise<MemberData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: MemberData }>({
    method: "POST",
    path: adminServicePath("members"),
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
    path: adminServicePath("members"),
    body: { ...input, intent: "update_role" },
  });
  return res.data;
}

export async function updateAdminMemberSiteAccess(input: {
  teamId: string;
  userId: string;
  siteIds: string[];
}): Promise<{ teamId: string; userId: string; siteIds: string[] }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { teamId: string; userId: string; siteIds: string[] };
  }>({
    method: "PATCH",
    path: adminServicePath("members"),
    body: { ...input, intent: "update_site_access" },
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
    path: adminServicePath("members"),
    body: input,
  });
  return res.data;
}

export async function fetchAdminSiteConfig(
  siteId: string,
): Promise<SiteScriptSettings> {
  const res = await fetchEdgeJson<SiteConfigData>({
    path: adminServicePath("site-config"),
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
    path: adminServicePath("site-config"),
    body: input,
  });
  return res.data;
}

export async function fetchAdminScriptSnippet(
  siteId: string,
): Promise<ScriptSnippetData["data"]> {
  const res = await fetchEdgeJson<ScriptSnippetData>({
    path: adminServicePath("script-snippet"),
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
    path: "/api/public/session",
    body: input,
  });
  return res.data;
}

export async function fetchAdminMe(): Promise<{
  user: AccountUserData;
  teams: TeamData[];
  teamGroups?: SessionTeamGroups;
}> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: {
      user: AccountUserData;
      teams: TeamData[];
      teamGroups?: SessionTeamGroups;
    };
  }>({
    path: adminServicePath("session"),
  });
  return res.data;
}

export async function fetchAdminUsers(): Promise<AccountUserData[]> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData[] }>({
    path: adminServicePath("users"),
  });
  return res.data;
}

export async function createAdminUser(input: {
  username: string;
  email: string;
  name?: string;
  password: string;
  systemRole?: "admin" | "user";
  teamName?: string;
  teamSlug?: string;
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "POST",
    path: adminServicePath("users"),
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
    path: adminServicePath("users"),
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
    path: adminServicePath("users"),
    body: {
      ...input,
      intent: "remove",
    },
  });
  return res.data;
}

export async function fetchNotificationRules(input: {
  teamId: string;
  signal?: AbortSignal;
}): Promise<NotificationRuleData[]> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: unknown;
  }>({
    path: adminServicePath("notification-rules"),
    params: { teamId: input.teamId },
    signal: input.signal,
  });
  return Array.isArray(res.data) ? (res.data as NotificationRuleData[]) : [];
}

export async function fetchNotificationEmailConfig(options?: {
  signal?: AbortSignal;
}): Promise<PublicNotificationEmailConfig> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: PublicNotificationEmailConfig;
  }>({
    path: adminServicePath("notification-email"),
    signal: options?.signal,
  });
  return res.data;
}

export async function createNotificationRule(input: {
  teamId: string;
  name: string;
  siteId?: string | null;
  description?: string;
  type?: string;
  enabled?: boolean;
  schedule?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  recipient?: Record<string, unknown>;
}): Promise<NotificationRuleData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationRuleData;
  }>({
    method: "POST",
    path: adminServicePath("notification-rules"),
    body: input,
  });
  return res.data;
}

export async function updateNotificationRule(input: {
  ruleId: string;
  teamId?: string;
  siteId?: string | null;
  name?: string;
  description?: string;
  type?: string;
  enabled?: boolean;
  schedule?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  recipient?: Record<string, unknown>;
}): Promise<NotificationRuleData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationRuleData;
  }>({
    method: "PATCH",
    path: adminServicePath("notification-rules"),
    body: input,
  });
  return res.data;
}

export async function deleteNotificationRule(input: {
  ruleId: string;
}): Promise<{ id: string; removed: boolean }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { id: string; removed: boolean };
  }>({
    method: "DELETE",
    path: adminServicePath("notification-rules"),
    params: { id: input.ruleId },
  });
  return res.data;
}

export async function previewNotificationRule(input: {
  ruleId: string;
}): Promise<NotificationRuleEvaluationData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationRuleEvaluationData;
  }>({
    method: "POST",
    path: adminServicePath("notification-rules/preview"),
    body: input,
  });
  return res.data;
}

export async function runNotificationRuleNow(input: {
  ruleId: string;
}): Promise<NotificationRuleRunData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationRuleRunData;
  }>({
    method: "POST",
    path: adminServicePath("notification-rules/run"),
    body: input,
  });
  return res.data;
}

export async function fetchNotificationMessages(input: {
  teamId?: string;
  siteId?: string;
  ruleId?: string;
  type?: string;
  severity?: string;
  unread?: boolean;
  locale?: Locale;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{
  messages: NotificationMessageData[];
  unreadAttentionCount: number;
}> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: unknown;
  }>({
    path: adminServicePath("notifications"),
    params: {
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.ruleId ? { ruleId: input.ruleId } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.unread ? { unread: 1 } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    },
    signal: input.signal,
  });
  const data =
    res.data && typeof res.data === "object"
      ? (res.data as {
          messages?: unknown;
          unreadAttentionCount?: unknown;
        })
      : {};
  return {
    messages: Array.isArray(data.messages)
      ? (data.messages as NotificationMessageData[])
      : [],
    unreadAttentionCount:
      typeof data.unreadAttentionCount === "number"
        ? data.unreadAttentionCount
        : 0,
  };
}

export async function fetchNotificationEmailPreview(input: {
  type: "test" | "report" | "milestone" | "threshold" | "change" | "health";
  locale: Locale;
  format: "html" | "text" | "json";
}): Promise<
  | string
  | {
      subject: string;
      html: string;
      text: string;
    }
> {
  const baseUrl = await edgeBaseUrl();
  const url = withQuery(
    new URL(adminServicePath("notification-email-preview"), baseUrl),
    input,
  );
  const headers = new Headers();
  try {
    const sessionToken = await getSessionToken();
    if (sessionToken) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
  } catch {
    // Ignore when session is unavailable outside request scope.
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Email preview failed (${res.status}): ${text}`);
  }
  if (input.format === "json") {
    const payload = (await res.json()) as {
      ok: boolean;
      data: { subject: string; html: string; text: string };
    };
    return payload.data;
  }
  return res.text();
}

export async function markNotificationMessageRead(input: {
  messageId: string;
  locale?: Locale;
}): Promise<NotificationMessageData | null> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationMessageData | null;
  }>({
    method: "PATCH",
    path: adminServicePath(
      `notifications/${encodeURIComponent(input.messageId)}`,
    ),
    body: { read: true, ...(input.locale ? { locale: input.locale } : {}) },
  });
  return res.data;
}

export async function markAllNotificationMessagesRead(input: {
  teamId?: string;
}): Promise<{ updated: number }> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: { updated: number };
  }>({
    method: "PATCH",
    path: adminServicePath("notifications/read-all"),
    body: { ...input, read: true },
  });
  return res.data;
}

export interface NotificationPreferencesData {
  inApp: boolean;
  email: boolean;
  webPush: boolean;
  attention: {
    reportsCreateUnread: boolean;
    milestonesCreateUnread: boolean;
    alertsCreateUnread: boolean;
  };
}

export const DEFAULT_NOTIFICATION_PREFERENCES_DATA: NotificationPreferencesData =
  {
    inApp: true,
    email: true,
    webPush: false,
    attention: {
      reportsCreateUnread: false,
      milestonesCreateUnread: false,
      alertsCreateUnread: true,
    },
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeNotificationPreferencesData(
  input: unknown,
): NotificationPreferencesData {
  const raw = isRecord(input) ? input : {};
  const attention = isRecord(raw.attention) ? raw.attention : {};
  const defaults = DEFAULT_NOTIFICATION_PREFERENCES_DATA;
  return {
    inApp: true,
    email: booleanOr(raw.email, defaults.email),
    webPush: booleanOr(raw.webPush, defaults.webPush),
    attention: {
      reportsCreateUnread: booleanOr(
        attention.reportsCreateUnread,
        defaults.attention.reportsCreateUnread,
      ),
      milestonesCreateUnread: booleanOr(
        attention.milestonesCreateUnread,
        defaults.attention.milestonesCreateUnread,
      ),
      alertsCreateUnread: booleanOr(
        attention.alertsCreateUnread,
        defaults.attention.alertsCreateUnread,
      ),
    },
  };
}

export type NotificationPreferencesUpdate = Partial<
  Omit<NotificationPreferencesData, "attention">
> & {
  attention?: Partial<NotificationPreferencesData["attention"]>;
};

export async function fetchNotificationPreferences(options?: {
  signal?: AbortSignal;
}): Promise<NotificationPreferencesData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationPreferencesData;
  }>({
    path: adminServicePath("notifications/preferences"),
    signal: options?.signal,
  });
  return normalizeNotificationPreferencesData(res.data);
}

export async function updateNotificationPreferences(
  input: NotificationPreferencesUpdate,
): Promise<NotificationPreferencesData> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: NotificationPreferencesData;
  }>({
    method: "PATCH",
    path: adminServicePath("notifications/preferences"),
    body: input,
  });
  return normalizeNotificationPreferencesData(res.data);
}

export async function sendNotificationTest(input: {
  teamId: string;
  siteId?: string;
  userId?: string;
}): Promise<{
  message: NotificationMessageData | null;
  summary: Record<string, unknown> | null;
}> {
  const res = await fetchEdgeJson<{
    ok: boolean;
    data: {
      message: NotificationMessageData | null;
      summary: Record<string, unknown> | null;
    };
  }>({
    method: "POST",
    path: adminServicePath("notification-test"),
    body: input,
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
  preferredLocale?: "" | "en" | "zh";
}): Promise<AccountUserData> {
  const res = await fetchEdgeJson<{ ok: boolean; data: AccountUserData }>({
    method: "POST",
    path: adminServicePath("profile"),
    body: input,
  });
  return res.data;
}
