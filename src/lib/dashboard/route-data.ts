import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { publicDashboardSiteId } from "@/lib/dashboard/client/request";
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
  type SystemSettingsInitialData,
  type TeamManagementInitialData,
  type TeamNotificationsInitialData,
} from "@/lib/dashboard/management-data";
import { resolveDashboardInitialWindow } from "@/lib/dashboard/query-preferences";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  getDashboardProfile,
  getDashboardRootContext,
  getDashboardRuntime,
  getDashboardTeamContext,
  getTeamSiteContext,
  readDashboardAdmin,
} from "@/lib/dashboard/server";
import {
  resolveTeamDashboardRequest,
  type SiteAnalyticsInitialPage,
  startSiteAnalyticsStream,
} from "@/lib/dashboard/server/query";
import type { TeamDashboardSnapshot } from "@/lib/dashboard/team-dashboard-query";
import { normalizeNotificationPreferencesData } from "@/lib/dashboard-api/client/edge";
import { fetchPublicSite } from "@/lib/dashboard-api/client/edge";
import type {
  NotificationMessageData,
  NotificationRuleData,
  SiteData,
} from "@/lib/dashboard-api/contract/types";
import { createTeamDashboardQueryRuntime } from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  createQueryTime,
  parseFilterUrlForAudience,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { currentInvocationLogger } from "@/lib/edge/observability/logger";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import {
  enableRequestReadCache,
  memoizeRequestRead,
} from "@/lib/edge/runtime/request-read-cache";
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
function readInitialWindow(): Promise<TimeWindow> {
  const request = getRequest();
  enableRequestReadCache(request);
  return memoizeRequestRead(request, "dashboard:window", async () => {
    const profile = await getDashboardProfile();
    const cookie = request.headers.get("cookie");
    const timeZone = profile?.user.timeZone;
    return timeZone
      ? resolveDashboardInitialWindow(cookie, undefined, timeZone)
      : resolveDashboardInitialWindow(cookie);
  });
}
/** Server-only initial analytics reads. The leaf loader awaits only the
 * authorization/setup, never the analytics promises in this returned map. */
export const loadSiteAnalyticsStream = createServerFn({ method: "GET" })
  .validator(
    (data: {
      siteId: string;
      search: string;
      page?: SiteAnalyticsInitialPage;
    }) => {
      if (
        typeof data.siteId !== "string" ||
        typeof data.search !== "string" ||
        data.search.length > 8192 ||
        (data.page !== undefined &&
          data.page !== "overview" &&
          data.page !== "pages" &&
          data.page !== "referrers" &&
          data.page !== "campaigns")
      )
        throw new Error("invalid_ssr_analytics");
      return data;
    },
  )
  .handler(async ({ data }) => {
    const [runtime, window] = await Promise.all([
      getDashboardRuntime(),
      readInitialWindow(),
    ]);
    return startSiteAnalyticsStream({
      ...runtime,
      siteId: data.siteId,
      window,
      search: data.search,
      page: data.page,
    });
  });

/** Provides the SSR-safe initial query window to the dashboard shell. */
export const loadDashboardInitialWindow = createServerFn({
  method: "GET",
}).handler(() => readInitialWindow());
export const loadDashboardTeam = createServerFn({ method: "GET" })
  .validator((data: { teamSlug: string }) => data)
  .handler(({ data }) => getDashboardTeamContext(data.teamSlug));
/** Loads the first team-dashboard snapshot on the server for a stable hydrate. */
async function readTeamDashboardSnapshot(data: {
  teamId: string;
}): Promise<TeamDashboardSnapshot | null> {
  const logger = currentInvocationLogger();
  return logger
    ? logger.measure("dashboard.team_snapshot", () =>
        executeTeamDashboardSnapshot(data),
      )
    : executeTeamDashboardSnapshot(data);
}

async function executeTeamDashboardSnapshot(data: {
  teamId: string;
}): Promise<TeamDashboardSnapshot | null> {
  const runtime = await getDashboardRuntime();
  const [resolved, preloadedSites, window] = await Promise.all([
    resolveTeamDashboardRequest({
      request: runtime.request,
      env: runtime.env,
      teamId: data.teamId,
    }),
    readDashboardAdmin("sites", { teamId: data.teamId }),
    readInitialWindow(),
  ]);
  if (resolved instanceof Response) return null;
  // Team overview/workspace do not expose site filters. Match the URL sent
  // by fetchTeamDashboard, not stale site filters carried in the page URL.
  const queryUrl = new URL("/api/private/team-dashboard", runtime.request.url);
  const filters = parseFilterUrlForAudience("private-dashboard", queryUrl);
  const capturedAtMs = appNow();
  const teamDashboardRuntime = createTeamDashboardQueryRuntime({
    env: resolved.env,
    teamId: resolved.teamId,
    window: {
      startMs: window.from,
      endExclusiveMs: window.to,
      nowMs: capturedAtMs,
      timeZone: window.timeZone,
    },
    interval: window.interval,
    allowedSiteIds: resolved.allowedSiteIds,
    preloadedSites: preloadedSites?.map((site) => ({
      ...site,
      publicEnabled: Number(Boolean(site.publicEnabled)),
    })),
  });
  const result = await teamDashboardRuntime.execute("team-dashboard", {
    context: teamQueryContext(
      resolved.teamId,
      "private-dashboard",
      resolved.allowedSiteIds,
    ),
    time: createQueryTime(
      window.from,
      window.to,
      window.timeZone,
      capturedAtMs,
    ),
    filters,
  });
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
}
export const loadTeamDashboardSnapshot = createServerFn({ method: "GET" })
  .validator((data: { teamId: string }) => data)
  .handler(({ data }) => readTeamDashboardSnapshot(data));
/** Most teams the workspace reads on one page load. */
export const WORKSPACE_TEAM_LIMIT = 20;
/**
 * Loads the first team-dashboard snapshot of every team on the workspace.
 * Each team is authorized on its own; a team that fails is left out instead of
 * failing the page.
 */
export const loadWorkspaceSnapshots = createServerFn({ method: "GET" })
  .validator((data: { teamIds: string[] }) => ({
    teamIds: Array.isArray(data.teamIds)
      ? [...new Set(data.teamIds.map(String))].slice(0, WORKSPACE_TEAM_LIMIT)
      : [],
  }))
  .handler(({ data }) => readWorkspaceSnapshots(data.teamIds));

async function readWorkspaceSnapshots(teamIds: string[]) {
  const entries = await Promise.all(
    teamIds.map(async (teamId) => {
      try {
        return [teamId, await readTeamDashboardSnapshot({ teamId })] as const;
      } catch {
        return [teamId, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<
    string,
    TeamDashboardSnapshot | null
  >;
}

/** Lightweight authorized inventory, independently streamed from analytics.
 * Null means the inventory could not be read, not an empty team. */
export const loadWorkspaceSiteInventory = createServerFn({ method: "GET" })
  .validator((data: { teamIds: string[] }) => ({
    teamIds: Array.isArray(data.teamIds)
      ? [...new Set(data.teamIds.map(String))].slice(0, WORKSPACE_TEAM_LIMIT)
      : [],
  }))
  .handler(async ({ data }): Promise<Record<string, SiteData[] | null>> => {
    const profile = await getDashboardProfile();
    const allowed = new Set(profile?.teams.map((team) => team.id) ?? []);
    const entries = await Promise.all(
      data.teamIds
        .filter((teamId) => allowed.has(teamId))
        .map(async (teamId) => {
          try {
            return [
              teamId,
              await readDashboardAdmin("sites", { teamId }),
            ] as const;
          } catch {
            return [teamId, null] as const;
          }
        }),
    );
    return Object.fromEntries(entries);
  });

/** One authenticated RPC for the shell and the matched team's initial page.
 * The client supplies route identifiers only; team IDs and ACLs are resolved here. */
export const loadDashboardBootstrap = createServerFn({ method: "GET" })
  .validator((data: { teamSlug?: string; page?: "workspace" | "team" }) => ({
    teamSlug:
      typeof data?.teamSlug === "string"
        ? data.teamSlug.slice(0, 120)
        : undefined,
    page:
      data?.page === "workspace" || data?.page === "team"
        ? data.page
        : undefined,
  }))
  .handler(async ({ data }) => {
    const logger = currentInvocationLogger();
    if (logger) {
      // Only fixed, low-cardinality identifiers; no slug, user or search data.
      const serverFn = new URL(getRequest().url).pathname.startsWith(
        "/_serverFn",
      );
      logger.setRouteKey(
        serverFn
          ? "server_function.dashboard.bootstrap"
          : "page.dashboard." + (data.page ?? "other"),
      );
      return logger.measure("dashboard.bootstrap", () =>
        readDashboardBootstrap(data),
      );
    }
    return readDashboardBootstrap(data);
  });

async function readDashboardBootstrap(data: {
  teamSlug?: string;
  page?: "workspace" | "team";
}) {
  const initialWindow = readInitialWindow();
  const root = getDashboardRootContext();
  const team = data.teamSlug
    ? getDashboardTeamContext(data.teamSlug)
    : Promise.resolve(null);
  const [dashboardRoot, initialDashboardWindow, bootstrapTeamContext] =
    await Promise.all([root, initialWindow, team]);
  return {
    dashboardRoot,
    initialDashboardWindow,
    bootstrapTeamContext,
    workspaceSnapshots: null,
    teamDashboardSnapshot: null,
  };
}

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
/** Each card can receive its snapshot independently, using the same ACL reads. */
export const loadSiteConfigSnapshot = createServerFn({ method: "GET" })
  .validator((data: { siteId: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<Pick<
      SiteSettingsInitialData,
      "config" | "fetchedAt"
    > | null> => {
      const config = await readDashboardAdmin("site-config", {
        siteId: data.siteId,
      });
      return config
        ? {
            config: { ...config, ...normalizeSiteScriptSettings(config) },
            fetchedAt: Date.now(),
          }
        : null;
    },
  );
export const loadSiteSnippetSnapshot = createServerFn({ method: "GET" })
  .validator((data: { siteId: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<Pick<
      SiteSettingsInitialData,
      "scriptSnippet" | "fetchedAt"
    > | null> => {
      const snippet = await readDashboardAdmin("script-snippet", {
        siteId: data.siteId,
      });
      return snippet
        ? { scriptSnippet: snippet.snippet, fetchedAt: Date.now() }
        : null;
    },
  );

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
export const loadAnalyticsEngineSnapshot = createServerFn({
  method: "GET",
}).handler(
  async (): Promise<Pick<
    SystemSettingsInitialData,
    "analyticsEngine" | "fetchedAt"
  > | null> => {
    const config = await readDashboardAdmin("analytics-engine-config");
    return config ? { analyticsEngine: config, fetchedAt: Date.now() } : null;
  },
);
export const loadLoginTurnstileSnapshot = createServerFn({
  method: "GET",
}).handler(
  async (): Promise<Pick<
    SystemSettingsInitialData,
    "loginTurnstile" | "fetchedAt"
  > | null> => {
    const config = await readDashboardAdmin("login-turnstile");
    return config ? { loginTurnstile: config, fetchedAt: Date.now() } : null;
  },
);
export const loadNotificationEmailSnapshot = createServerFn({
  method: "GET",
}).handler(
  async (): Promise<Pick<
    SystemSettingsInitialData,
    "notificationEmail" | "fetchedAt"
  > | null> => {
    const config = await readDashboardAdmin("notification-email");
    return config ? { notificationEmail: config, fetchedAt: Date.now() } : null;
  },
);
export const loadRetentionSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<Pick<
    SystemSettingsInitialData,
    "scheduledTaskRetention" | "fetchedAt"
  > | null> => {
    const config = (await readDashboardAdmin("scheduled-tasks", { limit: 1 }))
      ?.retention;
    return config
      ? { scheduledTaskRetention: config, fetchedAt: Date.now() }
      : null;
  },
);
export const loadSystemSettingsInitialData = createServerFn({
  method: "GET",
}).handler(async (): Promise<SystemSettingsInitialData | null> => {
  const [analyticsEngine, loginTurnstile, notificationEmail, scheduledTasks] =
    await Promise.all([
      readDashboardAdmin("analytics-engine-config"),
      readDashboardAdmin("login-turnstile"),
      readDashboardAdmin("notification-email"),
      readDashboardAdmin("scheduled-tasks", { limit: 1 }),
    ]);
  if (!analyticsEngine || !loginTurnstile || !notificationEmail) return null;
  return {
    analyticsEngine,
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
    limit: 50,
  });
  return data
    ? {
        ...serializeScheduledTasksData(data),
        fetchedAt: Date.now(),
      }
    : null;
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
