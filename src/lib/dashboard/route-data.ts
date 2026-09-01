import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { publicDashboardSiteId } from "@/lib/dashboard/client-request";
import {
  type AccountNotificationPreferencesInitialData,
  type AdminTeamsInitialData,
  type AdminUsersInitialData,
  type ApiKeysInitialData,
  type ManagementJsonObject,
  type NotificationCenterInitialData,
  type SafeTeamInviteData,
  type ScheduledTasksInitialData,
  type SerializableNotificationMessageData,
  type SerializableNotificationRuleData,
  type SerializableScheduledTasksData,
  type SiteSettingsInitialData,
  type SystemPerformanceInitialData,
  type SystemSettingsInitialData,
  type TeamManagementInitialData,
  type TeamNotificationsInitialData,
} from "@/lib/dashboard/management-data";
import { resolveDashboardInitialWindow } from "@/lib/dashboard/query-preferences";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  getDashboardRootContext,
  getDashboardTeamContext,
  getDashboardTeamSites,
  getTeamSiteContext,
  readDashboardAdmin,
} from "@/lib/dashboard/server";
import { resolveTeamDashboardRequest } from "@/lib/dashboard/server-query";
import type { TeamDashboardSnapshot } from "@/lib/dashboard/team-dashboard-query";
import {
  createTeamDashboardQueryRuntime,
  type SsrTeamDashboardData,
} from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  createQueryTime,
  parseFilterUrlForAudience,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import { normalizeNotificationPreferencesData } from "@/lib/edge-client";
import { fetchPublicSite } from "@/lib/edge-client";
import type {
  NotificationMessageData,
  NotificationRuleData,
} from "@/lib/edge-client-types";
import type { Locale } from "@/lib/i18n/config";
import { DEFAULT_RETENTION_CONFIG } from "@/lib/retention";
import type { ScheduledTasksData } from "@/lib/scheduled-tasks";
import { normalizeSiteScriptSettings } from "@/lib/site-settings";

function serializeManagementJsonObject(
  value: Record<string, unknown>,
): ManagementJsonObject {
  return JSON.parse(JSON.stringify(value)) as ManagementJsonObject;
}

function serializeNotificationRule(
  rule: NotificationRuleData,
): SerializableNotificationRuleData {
  return {
    ...rule,
    schedule: serializeManagementJsonObject(rule.schedule),
    condition: serializeManagementJsonObject(rule.condition),
    recipient: serializeManagementJsonObject(rule.recipient),
    state: serializeManagementJsonObject(rule.state),
  };
}

function serializeNotificationMessage(
  message: NotificationMessageData,
): SerializableNotificationMessageData {
  return {
    ...message,
    data: serializeManagementJsonObject(message.data),
    channels: serializeManagementJsonObject(message.channels),
    deliveryResults: serializeManagementJsonObject(message.deliveryResults),
  };
}

function serializeScheduledTasksData(
  data: ScheduledTasksData,
): SerializableScheduledTasksData {
  return JSON.parse(JSON.stringify(data)) as SerializableScheduledTasksData;
}

export const loadDashboardRoot = createServerFn({ method: "GET" }).handler(() =>
  getDashboardRootContext(),
);

/** Provides the SSR-safe initial query window to the dashboard shell. */
export const loadDashboardInitialWindow = createServerFn({
  method: "GET",
}).handler(
  (): TimeWindow =>
    resolveDashboardInitialWindow(getRequest().headers.get("cookie")),
);

export const loadDashboardTeam = createServerFn({ method: "GET" })
  .validator((data: { teamSlug: string }) => data)
  .handler(({ data }) => getDashboardTeamContext(data.teamSlug));

/** Loads the first team-dashboard snapshot on the server for a stable hydrate. */
export const loadTeamDashboardSnapshot = createServerFn({ method: "GET" })
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data }): Promise<TeamDashboardSnapshot | null> => {
    const request = getRequest();
    const runtime = await resolveEdgeRuntime(request);
    const resolved = await resolveTeamDashboardRequest({
      request,
      env: runtime.env,
      teamId: data.teamId,
    });
    if (resolved instanceof Response) return null;

    const preloadedSites = await getDashboardTeamSites(data.teamId);

    const window = resolveDashboardInitialWindow(request.headers.get("cookie"));
    const filters = parseFilterUrlForAudience("private-dashboard", request.url);
    const teamDashboardRuntime = createTeamDashboardQueryRuntime({
      env: resolved.env,
      teamId: resolved.teamId,
      window: {
        startMs: window.from,
        endExclusiveMs: window.to,
        nowMs: window.to,
        timeZone: window.timeZone,
      },
      interval: window.interval,
      allowedSiteIds: resolved.allowedSiteIds,
      preloadedSites: preloadedSites.map(({ slug: _slug, ...site }) => ({
        ...site,
        publicEnabled: Number(Boolean(site.publicEnabled)),
      })),
    });
    const result = await teamDashboardRuntime.execute<SsrTeamDashboardData>(
      "team-dashboard",
      {
        context: teamQueryContext(
          resolved.teamId,
          "private-dashboard",
          resolved.allowedSiteIds,
        ),
        time: createQueryTime(
          window.from,
          window.to,
          window.timeZone,
          window.to,
        ),
        filters,
      },
    );
    if (!result.ok) throw new Error(result.error.kind);
    return {
      data: result.data,
      window: {
        from: window.from,
        to: window.to,
        interval: window.interval,
        timeZone: window.timeZone,
      },
      range: window.preset,
      fetchedAt: Date.now(),
    };
  });

function safeInvite(invite: {
  id: string;
  email: string;
  payload: SafeTeamInviteData["payload"];
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUserId: string;
  revokedAt: number | null;
  status: SafeTeamInviteData["status"];
}): SafeTeamInviteData {
  return {
    id: invite.id,
    email: invite.email,
    payload: invite.payload,
    createdByUserId: invite.createdByUserId,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    usedByUserId: invite.usedByUserId,
    revokedAt: invite.revokedAt,
    status: invite.status,
  };
}

/** Loads the safe, non-secret read model used by team settings and members. */
export const loadTeamManagementInitialData = createServerFn({ method: "GET" })
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data }): Promise<TeamManagementInitialData | null> => {
    const [members, sites, invites] = await Promise.all([
      readDashboardAdmin("members", { teamId: data.teamId }),
      readDashboardAdmin("sites", { teamId: data.teamId }),
      readDashboardAdmin("team-invites", { teamId: data.teamId }),
    ]);
    if (!members || !sites || !invites) return null;
    return {
      members,
      sites,
      invites: invites.map(safeInvite),
      fetchedAt: Date.now(),
    };
  });

/** Loads tracker settings and the install snippet for site settings SSR. */
export const loadSiteSettingsInitialData = createServerFn({ method: "GET" })
  .validator((data: { siteId: string }) => data)
  .handler(async ({ data }): Promise<SiteSettingsInitialData | null> => {
    const [config, snippet] = await Promise.all([
      readDashboardAdmin("site-config", { siteId: data.siteId }),
      readDashboardAdmin("script-snippet", { siteId: data.siteId }),
    ]);
    if (!config || !snippet) return null;
    return {
      config: { ...config, ...normalizeSiteScriptSettings(config) },
      scriptSnippet: snippet.snippet,
      origin: new URL(getRequest().url).origin,
      fetchedAt: Date.now(),
    };
  });

/** Loads the site list already used as the management table's first snapshot. */
export const loadApiKeysInitialData = createServerFn({ method: "GET" })
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data }): Promise<ApiKeysInitialData | null> => {
    const keys = await readDashboardAdmin("api-keys", { teamId: data.teamId });
    return keys ? { keys, fetchedAt: Date.now() } : null;
  });

export const loadTeamNotificationsInitialData = createServerFn({
  method: "GET",
})
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data }): Promise<TeamNotificationsInitialData | null> => {
    const [rules, sites, members, emailConfig] = await Promise.all([
      readDashboardAdmin("notification-rules", { teamId: data.teamId }),
      readDashboardAdmin("sites", { teamId: data.teamId }),
      readDashboardAdmin("members", { teamId: data.teamId }),
      readDashboardAdmin("notification-email"),
    ]);
    if (!rules || !sites || !members) return null;
    return {
      rules: rules.map(serializeNotificationRule),
      sites,
      members,
      emailConfigured: Boolean(
        emailConfig?.enabled &&
        emailConfig.provider === "resend" &&
        emailConfig.fromEmail &&
        emailConfig.resend.configured,
      ),
      fetchedAt: Date.now(),
    };
  });

export const loadNotificationCenterInitialData = createServerFn({
  method: "GET",
})
  .validator(
    (data: { teamId?: string; ruleId?: string; locale: Locale }) => data,
  )
  .handler(async ({ data }): Promise<NotificationCenterInitialData | null> => {
    const notifications = await readDashboardAdmin("notifications", {
      teamId: data.teamId ?? "",
      ruleId: data.ruleId ?? "",
      locale: data.locale,
      limit: 80,
    });
    return notifications
      ? {
          ...notifications,
          messages: notifications.messages.map(serializeNotificationMessage),
          fetchedAt: Date.now(),
        }
      : null;
  });

export const loadAccountNotificationPreferences = createServerFn({
  method: "GET",
}).handler(
  async (): Promise<AccountNotificationPreferencesInitialData | null> => {
    const data = await readDashboardAdmin("notifications/preferences");
    return data
      ? {
          preferences: normalizeNotificationPreferencesData(data),
          fetchedAt: Date.now(),
        }
      : null;
  },
);

export const loadAdminTeamsInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<AdminTeamsInitialData | null> => {
  const teams = await readDashboardAdmin("teams");
  return teams ? { teams, fetchedAt: Date.now() } : null;
});

export const loadAdminUsersInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<AdminUsersInitialData | null> => {
  const users = await readDashboardAdmin("users");
  return users ? { users, fetchedAt: Date.now() } : null;
});

export const loadSystemSettingsInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<SystemSettingsInitialData | null> => {
  const [botAnalytics, loginTurnstile, notificationEmail, scheduledTasks] =
    await Promise.all([
      readDashboardAdmin("bot-analytics-config"),
      readDashboardAdmin("login-turnstile"),
      readDashboardAdmin("notification-email"),
      readDashboardAdmin("scheduled-tasks", { page: 1, pageSize: 1 }),
    ]);
  if (!botAnalytics || !loginTurnstile || !notificationEmail) return null;
  return {
    botAnalytics,
    loginTurnstile,
    notificationEmail,
    scheduledTaskRetention:
      scheduledTasks?.retention ?? DEFAULT_RETENTION_CONFIG,
    fetchedAt: Date.now(),
  };
});

export const loadScheduledTasksInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<ScheduledTasksInitialData | null> => {
  const data = await readDashboardAdmin("scheduled-tasks", {
    page: 1,
    pageSize: 50,
  });
  return data
    ? {
        ...serializeScheduledTasksData(data),
        fetchedAt: Date.now(),
      }
    : null;
});

export const loadSystemPerformanceInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<SystemPerformanceInitialData | null> => {
  const data = await readDashboardAdmin("system-performance", {
    minutes: 60,
  });
  return data ? { data, fetchedAt: Date.now() } : null;
});

export const loadDashboardSite = createServerFn({ method: "GET" })
  .validator((data: { teamSlug: string; siteSlug: string }) => data)
  .handler(({ data }) => getTeamSiteContext(data.teamSlug, data.siteSlug));

export const loadShareSite = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }) => {
    try {
      const site = await fetchPublicSite(data.slug);
      return { site, publicSiteId: publicDashboardSiteId(data.slug) };
    } catch {
      return null;
    }
  });

export const loadRequestOrigin = createServerFn({ method: "GET" }).handler(
  () => {
    const request = getRequest();
    const host =
      request.headers.get("x-forwarded-host") || request.headers.get("host");
    if (!host) return "";
    const proto =
      request.headers.get("x-forwarded-proto") ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return `${proto}://${host}`;
  },
);
