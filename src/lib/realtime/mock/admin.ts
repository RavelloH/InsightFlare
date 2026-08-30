import type {
  ApiKeyData,
  ApiKeyScope,
  NotificationMessageData,
  NotificationRuleData,
} from "@/lib/edge-client-types/admin";
import { isValidLocale, type Locale } from "@/lib/i18n/config";
import { buildNotificationContent } from "@/lib/notifications/content";
import { renderNotificationPlainText } from "@/lib/notifications/email-text";
import type { NotificationMessage } from "@/lib/notifications/message-store";
import type {
  NotificationMessageType,
  NotificationSeverity,
} from "@/lib/notifications/message-types";
import {
  DEMO_SITE_PROFILES,
  DEMO_TEAMS,
  demoSitePublicSlug,
} from "@/lib/realtime/demo-site-profiles";
import { fnv1a, mulberry32, sFloat, sInt } from "@/lib/realtime/demo-utils";
import { integrateViews } from "@/lib/realtime/mock/site-curves";
import {
  SCHEDULED_TASK_LOG_RETENTION_DAYS,
  type ScheduledTaskRun,
  type ScheduledTaskRunGroup,
  type ScheduledTaskRunLog,
  type ScheduledTasksData,
  type ScheduledTaskStatus,
  type ScheduledTaskSummary,
} from "@/lib/scheduled-tasks";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticSiteEntry,
  SystemPerformanceData,
  SystemPerformanceSlowEvent,
  SystemPerformanceTopSite,
  SystemPerformanceTrendPoint,
  SystemPerformanceWindowMinutes,
} from "@/lib/system-performance";
// ---------------------------------------------------------------------------
//  Admin data generators (fixed structure)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

const DEMO_USERS = [
  {
    id: "demo-user-001",
    username: "demo",
    email: "demo@insightflare.net",
    name: "Demo User",
    systemRole: "admin" as const,
    timeZone: "",
    teamCount: 1,
    ownedTeamCount: 1,
    createdDaysAgo: 180,
    updatedDaysAgo: 2,
  },
  {
    id: "demo-user-002",
    username: "mia",
    email: "mia@example.test",
    name: "Mia Chen",
    systemRole: "user" as const,
    timeZone: "Asia/Shanghai",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 90,
    updatedDaysAgo: 4,
  },
  {
    id: "demo-user-003",
    username: "alex",
    email: "alex@example.test",
    name: "Alex Rivera",
    systemRole: "user" as const,
    timeZone: "America/Los_Angeles",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 42,
    updatedDaysAgo: 1,
  },
  {
    id: "demo-user-004",
    username: "ops-admin",
    email: "ops@example.test",
    name: "Ops Admin",
    systemRole: "admin" as const,
    timeZone: "UTC",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 24,
    updatedDaysAgo: 3,
  },
] as const;

export function getDemoUsers() {
  const now = Date.now();
  return DEMO_USERS.map((user) => ({
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    systemRole: user.systemRole,
    timeZone: user.timeZone,
    preferredLocale: "" as const,
    createdAt: now - user.createdDaysAgo * DAY_MS,
    updatedAt: now - user.updatedDaysAgo * DAY_MS,
    teamCount: user.teamCount,
    ownedTeamCount: user.ownedTeamCount,
  }));
}

export function getDemoUser() {
  const user = getDemoUsers()[0];
  return {
    ...user,
  };
}

export function getDemoTeams() {
  const now = Date.now();
  return DEMO_TEAMS.map((t) => {
    const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      ownerUserId: t.ownerUserId,
      createdAt: now - 180 * DAY_MS,
      updatedAt: now - sInt(mulberry32(fnv1a(t.id)), 1, 30) * DAY_MS,
      siteCount: teamSites.length,
      memberCount: getDemoUsers().length,
      membershipRole: "owner",
    };
  });
}

export function getDemoSites(teamId: string) {
  const now = Date.now();
  return DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId).map((s) => ({
    id: s.id,
    teamId: s.teamId,
    name: s.name,
    domain: s.domain,
    iconPath: s.iconPath,
    publicEnabled: true,
    publicSlug: demoSitePublicSlug(s),
    createdAt: now - 180 * DAY_MS,
    updatedAt: now - sInt(mulberry32(fnv1a(s.id)), 1, 14) * DAY_MS,
  }));
}

export function getDemoMembers(teamId: string) {
  const sites = getDemoSites(teamId);
  return getDemoUsers().map((user, index) => ({
    teamId,
    userId: user.id,
    role:
      index === 0
        ? ("owner" as const)
        : index === 3
          ? ("admin" as const)
          : ("member" as const),
    siteIds: index === 2 ? sites.slice(0, 2).map((site) => site.id) : [],
    joinedAt: user.createdAt,
    username: user.username,
    email: user.email,
    name: user.name,
  }));
}

export function generateDemoTeamInvites(teamId: string) {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  return [
    {
      id: "demo-team-invite-product",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "product@example.test",
      payload: { teamRole: "admin", siteIds: [] },
      code: "demo_product_admin_token",
      url: "https://demo.insightflare.net/invite#token=demo_product_admin_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 2 * 24 * 60 * 60,
      expiresAt: now + 5 * 24 * 60 * 60,
      usedAt: null,
      usedByUserId: "",
      revokedAt: null,
      status: "active" as const,
    },
    {
      id: "demo-team-invite-analyst",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "",
      payload: { teamRole: "member", siteIds: [] },
      code: "demo_open_member_token",
      url: "https://demo.insightflare.net/invite#token=demo_open_member_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 6 * 60 * 60,
      expiresAt: now + 72 * 60 * 60,
      usedAt: null,
      usedByUserId: "",
      revokedAt: null,
      status: "active" as const,
    },
    {
      id: "demo-team-invite-used",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "mia@example.test",
      payload: {
        teamRole: "member",
        siteIds: getDemoSites(tid)
          .slice(0, 1)
          .map((site) => site.id),
      },
      code: "demo_used_member_token",
      url: "https://demo.insightflare.net/invite#token=demo_used_member_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 21 * 24 * 60 * 60,
      expiresAt: now + 9 * 24 * 60 * 60,
      usedAt: now - 20 * 24 * 60 * 60,
      usedByUserId: "demo-user-002",
      revokedAt: null,
      status: "used" as const,
    },
  ];
}

export function getDemoSiteConfig() {
  return {
    trackingStrength: "smart" as const,
    trackQueryParams: true,
    trackHash: true,
    domainWhitelist: [] as string[],
    pathBlacklist: [] as string[],
    ignoreDoNotTrack: true,
    performanceSampleRate: 100,
  };
}

export function getDemoScriptSnippet(siteId: string) {
  const edgeBase =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://localhost:3000";
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return {
    siteId,
    src,
    snippet: `<script defer src="${src}"></script>`,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function nextHourSeconds(now: number): number {
  return Math.floor(now / 3600) * 3600 + 3600;
}

const DEMO_API_KEY_SCOPES: ApiKeyScope[][] = [
  ["analytics:read", "site:read"],
  ["analytics:read", "site_config:read"],
  ["site:read", "site:write", "site_config:read"],
];

export function generateDemoApiKeys(teamId: string): ApiKeyData[] {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  const sites = getDemoSites(tid);
  return [
    {
      id: "demo-api-key-reporting",
      teamId: tid,
      name: "Dashboard reporting",
      prefix: "if_demo_01_4f8c2a",
      scopes: DEMO_API_KEY_SCOPES[0] ?? ["analytics:read"],
      siteIds: [],
      createdByUserId: getDemoUser().id,
      expiresAt: now + 180 * 24 * 60 * 60,
      revokedAt: null,
      revokedByUserId: "",
      rotatedFromKeyId: "",
      lastUsedAt: now - 18 * 60,
      createdAt: now - 21 * 24 * 60 * 60,
      updatedAt: now - 18 * 60,
      status: "active",
    },
    {
      id: "demo-api-key-config",
      teamId: tid,
      name: "Site config automation",
      prefix: "if_demo_02_91bd73",
      scopes: DEMO_API_KEY_SCOPES[1] ?? ["site_config:read"],
      siteIds: sites.slice(0, 2).map((site) => site.id),
      createdByUserId: getDemoUser().id,
      expiresAt: now + 365 * 24 * 60 * 60,
      revokedAt: null,
      revokedByUserId: "",
      rotatedFromKeyId: "",
      lastUsedAt: now - 6 * 60 * 60,
      createdAt: now - 45 * 24 * 60 * 60,
      updatedAt: now - 6 * 60 * 60,
      status: "active",
    },
    {
      id: "demo-api-key-legacy",
      teamId: tid,
      name: "Legacy importer",
      prefix: "if_demo_03_c0ffee",
      scopes: DEMO_API_KEY_SCOPES[2] ?? ["site:read"],
      siteIds: sites.slice(0, 1).map((site) => site.id),
      createdByUserId: getDemoUser().id,
      expiresAt: null,
      revokedAt: now - 2 * 24 * 60 * 60,
      revokedByUserId: getDemoUser().id,
      rotatedFromKeyId: "",
      lastUsedAt: null,
      createdAt: now - 90 * 24 * 60 * 60,
      updatedAt: now - 2 * 24 * 60 * 60,
      status: "revoked",
    },
  ];
}

function demoNotificationMessage(
  input: Omit<
    Partial<NotificationMessageData>,
    "bodyText" | "data" | "severity" | "summary" | "title" | "type"
  > & {
    teamId: string;
    type: NotificationMessageType;
    severity: NotificationSeverity;
    title: string;
    summary: string;
    bodyText: string;
    data: Record<string, unknown>;
    userId?: string;
  },
): NotificationMessageData {
  const now = nowSeconds();
  const createdAt = input.createdAt ?? now;
  return {
    id: input.id ?? "demo-notification-message-001",
    teamId: input.teamId,
    siteId: input.siteId ?? null,
    userId: input.userId ?? getDemoUser().id,
    ruleId: input.ruleId ?? null,
    runId: input.runId ?? "demo-run-notification",
    batchId: input.batchId ?? "demo-batch-notification",
    type: input.type,
    severity: input.severity,
    requiresAttention: input.requiresAttention ?? false,
    title: input.title,
    summary: input.summary,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml ?? "",
    data: input.data,
    channels: input.channels ?? { inApp: true, email: true },
    deliveryStatus: input.deliveryStatus ?? "sent",
    deliveryResults: input.deliveryResults ?? {
      inApp: { status: "sent" },
      email: { status: "skipped", reason: "system_email_unconfigured" },
    },
    errorMessage: input.errorMessage ?? "",
    readAt: input.readAt ?? null,
    dismissedAt: input.dismissedAt ?? null,
    archivedAt: input.archivedAt ?? null,
    triggeredAt: input.triggeredAt ?? createdAt,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    sentAt: input.sentAt ?? createdAt,
    failedAt: input.failedAt ?? null,
    expiresAt: input.expiresAt ?? createdAt + 30 * 24 * 60 * 60,
  };
}

function demoTypedNotificationMessage(
  input: Omit<
    Partial<NotificationMessageData>,
    "bodyText" | "data" | "severity" | "summary" | "title" | "type"
  > & {
    teamId: string;
    type: NotificationMessageType;
    severity: NotificationSeverity;
    data: Record<string, unknown>;
    locale: Locale;
    bodyText?: string;
    summary?: string;
    title?: string;
  },
): NotificationMessageData {
  const content = buildNotificationContent({
    type: input.type,
    severity: input.severity,
    data: input.data,
    locale: input.locale,
    fallbackTitle: input.title,
    fallbackSummary: input.summary,
    fallbackBodyText: input.bodyText,
  });
  const data = {
    ...input.data,
    locale: input.locale,
  };
  const bodyText =
    input.bodyText ??
    renderNotificationPlainText({
      content,
      locale: input.locale,
      message: {
        id: input.id ?? "demo-notification-message",
        teamId: input.teamId,
        siteId: input.siteId ?? null,
        userId: input.userId ?? getDemoUser().id,
        ruleId: input.ruleId ?? null,
        runId: input.runId ?? null,
        batchId: input.batchId ?? null,
        type: input.type,
        severity: input.severity,
        requiresAttention: input.requiresAttention ?? false,
        data,
        title: input.title ?? content.title,
        summary: input.summary ?? content.summary,
        bodyText: content.bodyText,
        bodyHtml: input.bodyHtml ?? "",
        channels: input.channels ?? { inApp: true, email: true },
        deliveryStatus: input.deliveryStatus ?? "sent",
        deliveryResults: input.deliveryResults ?? {},
        errorMessage: input.errorMessage ?? "",
        readAt: input.readAt ?? null,
        dismissedAt: input.dismissedAt ?? null,
        archivedAt: input.archivedAt ?? null,
        triggeredAt: input.triggeredAt ?? null,
        createdAt: input.createdAt ?? 0,
        updatedAt: input.updatedAt ?? input.createdAt ?? 0,
        sentAt: input.sentAt ?? null,
        failedAt: input.failedAt ?? null,
        expiresAt: input.expiresAt ?? null,
      } satisfies NotificationMessage,
    });
  return demoNotificationMessage({
    ...input,
    title: input.title ?? content.title,
    summary: input.summary ?? content.summary,
    bodyText,
    data,
  });
}

export function generateDemoNotificationRules(
  teamId: string,
): NotificationRuleData[] {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  const sites = getDemoSites(tid);
  const site = sites[0] ?? null;
  const secondarySite = sites[1] ?? site;
  return [
    {
      id: "demo-notification-rule-hourly",
      teamId: tid,
      siteId: site?.id ?? null,
      name: "Hourly notification test",
      description: "Demo rule for validating notification delivery.",
      type: "test",
      enabled: true,
      schedule: { kind: "interval", everyMinutes: 60 },
      condition: {},
      recipient: { mode: "creator" },
      state: {},
      lastCheckedAt: now - 3600,
      lastTriggeredAt: now - 3600,
      nextRunAt: nextHourSeconds(now),
      cooldownUntil: null,
      createdByUserId: getDemoUser().id,
      createdAt: now - 7 * 24 * 60 * 60,
      updatedAt: now - 3600,
    },
    {
      id: "demo-notification-rule-conversion-drop",
      teamId: tid,
      siteId: site?.id ?? null,
      name: "Checkout conversion guard",
      description: "Warns when recent purchase events fall below target.",
      type: "threshold",
      enabled: true,
      schedule: { kind: "interval", everyMinutes: 60 },
      condition: {
        metric: "sessions",
        window: "last_1h",
        operator: "<",
        value: 120,
        cooldownMinutes: 180,
      },
      recipient: { mode: "team_admins" },
      state: {},
      lastCheckedAt: now - 42 * 60,
      lastTriggeredAt: now - 2 * 60 * 60,
      nextRunAt: nextHourSeconds(now),
      cooldownUntil: now + 36 * 60,
      createdByUserId: getDemoUser().id,
      createdAt: now - 10 * 24 * 60 * 60,
      updatedAt: now - 42 * 60,
    },
    {
      id: "demo-notification-rule-no-data",
      teamId: tid,
      siteId: secondarySite?.id ?? null,
      name: "No data health check",
      description: "Raises a critical alert when tracking goes quiet.",
      type: "health",
      enabled: true,
      schedule: { kind: "interval", everyMinutes: 360 },
      condition: { check: "no_data", hours: 6, cooldownMinutes: 720 },
      recipient: { mode: "all_team_members" },
      state: {},
      lastCheckedAt: now - 3 * 60 * 60,
      lastTriggeredAt: now - 9 * 60 * 60,
      nextRunAt: nextHourSeconds(now + 3 * 60 * 60),
      cooldownUntil: null,
      createdByUserId: getDemoUser().id,
      createdAt: now - 20 * 24 * 60 * 60,
      updatedAt: now - 3 * 60 * 60,
    },
    {
      id: "demo-notification-rule-daily",
      teamId: tid,
      siteId: null,
      name: "Daily traffic report",
      description: "Demo daily summary for team administrators.",
      type: "report",
      enabled: true,
      schedule: { kind: "daily", time: "08:00", timezone: "Asia/Shanghai" },
      condition: {},
      recipient: { mode: "team_admins" },
      state: {},
      lastCheckedAt: now - 24 * 60 * 60,
      lastTriggeredAt: now - 24 * 60 * 60,
      nextRunAt: nextHourSeconds(now + 20 * 60 * 60),
      cooldownUntil: null,
      createdByUserId: getDemoUser().id,
      createdAt: now - 14 * 24 * 60 * 60,
      updatedAt: now - 24 * 60 * 60,
    },
    {
      id: "demo-notification-rule-weekly-growth",
      teamId: tid,
      siteId: null,
      name: "Weekly growth summary",
      description: "Scheduled leadership report for all demo sites.",
      type: "report",
      enabled: false,
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      condition: { reportType: "daily" },
      recipient: { mode: "creator" },
      state: {},
      lastCheckedAt: now - 3 * 24 * 60 * 60,
      lastTriggeredAt: now - 7 * 24 * 60 * 60,
      nextRunAt: null,
      cooldownUntil: null,
      createdByUserId: getDemoUser().id,
      createdAt: now - 34 * 24 * 60 * 60,
      updatedAt: now - 2 * 24 * 60 * 60,
    },
  ];
}

export function createDemoNotificationRule(
  body: unknown,
): NotificationRuleData {
  const raw =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const now = nowSeconds();
  const teamId = String(raw.teamId || getDemoTeams()[0].id);
  const schedule =
    raw.schedule && typeof raw.schedule === "object"
      ? (raw.schedule as Record<string, unknown>)
      : { kind: "interval", everyMinutes: 60 };
  const recipient =
    raw.recipient && typeof raw.recipient === "object"
      ? (raw.recipient as Record<string, unknown>)
      : { mode: "creator" };
  return {
    id: `demo-notification-rule-${now}`,
    teamId,
    siteId: typeof raw.siteId === "string" && raw.siteId ? raw.siteId : null,
    name: String(raw.name || "Notification rule"),
    description: String(raw.description || ""),
    type: String(raw.type || "test"),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    schedule,
    condition:
      raw.condition && typeof raw.condition === "object"
        ? (raw.condition as Record<string, unknown>)
        : {},
    recipient,
    state: {},
    lastCheckedAt: null,
    lastTriggeredAt: null,
    nextRunAt: nextHourSeconds(now),
    cooldownUntil: null,
    createdByUserId: getDemoUser().id,
    createdAt: now,
    updatedAt: now,
  };
}

export function generateDemoNotificationMessages(
  teamId: string,
  locale: Locale = "en",
): NotificationMessageData[] {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  const sites = getDemoSites(tid);
  const primarySite = sites[0] ?? null;
  const docsSite = sites[1] ?? primarySite;
  const apiSite = sites[2] ?? primarySite;
  const primaryDomain = primarySite?.domain ?? "demo.insightflare.net";
  const docsDomain = docsSite?.domain ?? "docs.insightflare.net";
  const apiDomain = apiSite?.domain ?? "api.insightflare.net";
  return [
    demoTypedNotificationMessage({
      id: "demo-notification-message-attention",
      teamId: tid,
      siteId: primarySite?.id ?? null,
      ruleId: "demo-notification-rule-conversion-drop",
      type: "threshold",
      severity: "warning",
      requiresAttention: true,
      locale,
      data: {
        siteDomain: primaryDomain,
        metric: "sessions",
        window: "last_1h",
        value: 84,
        operator: "<",
        target: 120,
      },
      readAt: null,
      createdAt: now - 25 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-conversion-drop",
      teamId: tid,
      siteId: primarySite?.id ?? null,
      ruleId: "demo-notification-rule-conversion-drop",
      type: "change",
      severity: "critical",
      requiresAttention: true,
      locale,
      data: {
        siteDomain: primaryDomain,
        metric: "visitors",
        window: "last_24h",
        previous: 920,
        current: 1860,
        change: 102.1,
        mode: "percent",
      },
      deliveryStatus: "partial",
      deliveryResults: {
        inApp: { status: "sent" },
        email: { status: "failed", reason: "provider_failed" },
      },
      errorMessage: "Demo provider rejected one recipient.",
      readAt: null,
      createdAt: now - 58 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-milestone",
      teamId: tid,
      siteId: primarySite?.id ?? null,
      ruleId: "demo-notification-rule-hourly",
      type: "milestone",
      severity: "success",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: primaryDomain,
        metric: "visitors",
        value: 50240,
        step: 10000,
        bucket: 50000,
      },
      readAt: null,
      createdAt: now - 82 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-health",
      teamId: tid,
      siteId: docsSite?.id ?? null,
      ruleId: "demo-notification-rule-no-data",
      type: "health",
      severity: "critical",
      requiresAttention: true,
      locale,
      data: {
        siteDomain: docsDomain,
        hours: 6,
        lastSeenAt: now - 7 * 60 * 60,
      },
      readAt: null,
      createdAt: now - 9 * 60 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-report",
      teamId: tid,
      siteId: primarySite?.id ?? null,
      ruleId: "demo-notification-rule-daily",
      type: "report",
      severity: "info",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: primaryDomain,
        reportType: "daily",
        range: { label: "2026-06-29" },
        metrics: { views: 3820, visitors: 1240, sessions: 1510 },
        topPages: [
          { path: "/", views: 1200 },
          { path: "/pricing", views: 420 },
          { path: "/docs/getting-started", views: 380 },
        ],
        topReferrers: [
          { referrer: "Google", visits: 520 },
          { referrer: "Product Hunt", visits: 240 },
          { referrer: "Direct", visits: 160 },
        ],
      },
      readAt: now - 2 * 60 * 60,
      createdAt: now - 3 * 60 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-weekly-report",
      teamId: tid,
      siteId: docsSite?.id ?? null,
      ruleId: "demo-notification-rule-weekly-growth",
      type: "report",
      severity: "success",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: docsDomain,
        reportType: "weekly",
        range: { label: "2026-06-23 - 2026-06-29" },
        metrics: { views: 18240, visitors: 6940, sessions: 7810 },
        topPages: [
          { path: "/docs", views: 3600 },
          { path: "/docs/api", views: 2100 },
          { path: "/docs/install", views: 1880 },
        ],
        topReferrers: [
          { referrer: "Google", visits: 2140 },
          { referrer: "GitHub", visits: 920 },
          { referrer: "Direct", visits: 760 },
        ],
      },
      readAt: now - 26 * 60 * 60,
      createdAt: now - 28 * 60 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-campaign-spike",
      teamId: tid,
      siteId: primarySite?.id ?? null,
      ruleId: "demo-notification-rule-hourly",
      type: "change",
      severity: "success",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: primaryDomain,
        metric: "sessions",
        window: "last_1h",
        previous: 410,
        current: 688,
        change: 67.8,
        mode: "percent",
      },
      readAt: null,
      createdAt: now - 95 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-api-latency",
      teamId: tid,
      siteId: apiSite?.id ?? null,
      ruleId: "demo-notification-rule-conversion-drop",
      type: "threshold",
      severity: "warning",
      requiresAttention: true,
      locale,
      data: {
        siteDomain: apiDomain,
        metric: "views",
        window: "last_24h",
        value: 15680,
        operator: ">=",
        target: 12000,
      },
      readAt: null,
      createdAt: now - 2 * 60 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-monthly-report",
      teamId: tid,
      siteId: apiSite?.id ?? null,
      ruleId: "demo-notification-rule-daily",
      type: "report",
      severity: "info",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: apiDomain,
        reportType: "monthly",
        range: { label: "2026-06" },
        metrics: { views: 72400, visitors: 21840, sessions: 28910 },
        topPages: [
          { path: "/api", views: 14200 },
          { path: "/api/auth", views: 9800 },
          { path: "/api/webhooks", views: 7400 },
        ],
        topReferrers: [
          { referrer: "GitHub", visits: 3820 },
          { referrer: "Google", visits: 2940 },
          { referrer: "Direct", visits: 1660 },
        ],
      },
      readAt: now - 4 * 24 * 60 * 60,
      createdAt: now - 4 * 24 * 60 * 60 - 20 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-recovery",
      teamId: tid,
      siteId: docsSite?.id ?? null,
      ruleId: "demo-notification-rule-no-data",
      type: "health",
      severity: "success",
      requiresAttention: false,
      locale,
      data: {
        siteDomain: docsDomain,
        hours: 6,
        lastSeenAt: now - 8 * 60,
      },
      readAt: now - 6 * 60 * 60,
      createdAt: now - 7 * 60 * 60,
    }),
    demoTypedNotificationMessage({
      id: "demo-notification-message-test",
      teamId: tid,
      ruleId: null,
      type: "test",
      severity: "success",
      requiresAttention: false,
      locale,
      data: {
        source: "demo",
      },
      readAt: now - 65 * 60,
      createdAt: now - 70 * 60,
    }),
  ];
}

export function generateDemoNotificationTest(body: unknown): {
  message: NotificationMessageData;
  summary: Record<string, unknown>;
} {
  const raw =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const teamId = String(raw.teamId || getDemoTeams()[0].id);
  const userId = String(raw.userId || getDemoUser().id);
  const requestedLocale = String(raw.locale || "");
  const locale: Locale = isValidLocale(requestedLocale)
    ? requestedLocale
    : "en";
  const message = demoTypedNotificationMessage({
    id: `demo-notification-test-${nowSeconds()}`,
    teamId,
    userId,
    siteId: typeof raw.siteId === "string" && raw.siteId ? raw.siteId : null,
    type: "test",
    severity: "info",
    requiresAttention: false,
    locale,
    data: { source: "demo_notification_test" },
  });
  return {
    message,
    summary: {
      checkedRules: 0,
      matchedRules: 1,
      messagesCreated: 1,
      deliveriesSent: 1,
      deliveriesFailed: 0,
      triggerType: "manual",
    },
  };
}

const DEMO_SCHEDULED_TASK_DEFINITIONS = [
  {
    key: "visit_hourly_rollup",
    name: "Hourly visit aggregation",
    description:
      "Aggregates closed visit rows into hourly rollups for dashboard counters and trends.",
    schedule: "Every hour",
    trigger: "cron" as const,
    enabled: true,
  },
  {
    key: "notification_tick",
    name: "Notification dispatch",
    description: "Evaluates notification rules and dispatches messages.",
    schedule: "Every hour",
    trigger: "cron" as const,
    enabled: true,
  },
];

function demoScheduledTaskStatus(index: number): ScheduledTaskStatus {
  if (index === 0) return "success";
  if (index % 29 === 0) return "failed";
  if (index % 17 === 0) return "partial";
  if (index % 11 === 0) return "skipped";
  return "success";
}

function demoScheduledRuns(now: number): ScheduledTaskRun[] {
  const runs: ScheduledTaskRun[] = [];
  for (let index = 0; index < 30 * 24; index += 1) {
    const startedAt =
      now -
      index * 60 * 60 * 1000 -
      sInt(mulberry32(fnv1a(`scheduled-run:${index}:offset`)), 8_000, 90_000);
    const status = demoScheduledTaskStatus(index);
    const rng = mulberry32(fnv1a(`scheduled-run:${index}`));
    const processedSites = status === "skipped" ? 0 : sInt(rng, 7, 12);
    const failedSites = status === "failed" ? 3 : status === "partial" ? 1 : 0;
    const hoursAggregated =
      status === "skipped" ? 0 : processedSites * sInt(rng, 4, 14);
    const durationMs =
      status === "skipped" ? sInt(rng, 140, 420) : sInt(rng, 1_300, 7_800);
    runs.push({
      id: `demo-run-${String(index).padStart(4, "0")}`,
      invocationId: `demo-invocation-${String(index).padStart(4, "0")}`,
      taskKey: "visit_hourly_rollup",
      taskName: "Hourly visit aggregation",
      triggerType: "cron",
      status,
      scheduledAt: Math.floor(startedAt / (60 * 60 * 1000)) * 60 * 60 * 1000,
      startedAt,
      finishedAt: startedAt + durationMs,
      durationMs,
      scopeType: "system",
      scopeId: null,
      summary: {
        cutoffMs: startedAt - 12 * 60 * 60 * 1000,
        candidateSites: processedSites + (status === "skipped" ? 0 : 1),
        sitesProcessed: processedSites,
        sitesFailed: failedSites,
        sitesBlockedByOpenVisit: status === "partial" ? 1 : 0,
        hoursAggregated,
        rollupRowsWritten:
          status === "skipped" ? 0 : hoursAggregated - sInt(rng, 0, 6),
      },
      errorName: status === "failed" ? "D1BatchError" : null,
      errorMessage:
        status === "failed"
          ? "D1 batch rejected while updating one site rollup"
          : status === "partial"
            ? "One site failed; remaining sites completed"
            : null,
      workerVersion: "demo",
      createdAt: startedAt,
      expiresAt:
        startedAt + SCHEDULED_TASK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
  }
  return runs;
}

function demoScheduledLogs(run: ScheduledTaskRun): ScheduledTaskRunLog[] {
  const summary = run.summary as Record<string, number>;
  const base = run.startedAt;
  const rows: ScheduledTaskRunLog[] = [
    {
      id: `${run.id}-log-1`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 1,
      level: "info",
      event: "start",
      message: "Task run started",
      data: {
        triggerType: run.triggerType,
        scheduledAt: run.scheduledAt,
      },
      createdAt: base,
    },
    {
      id: `${run.id}-log-2`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 2,
      level: "info",
      event: "aggregation_candidates",
      message: "Aggregation candidates loaded",
      data: {
        candidateSites: summary.candidateSites ?? 0,
        lagHours: 12,
        maxHoursPerSite: 168,
      },
      createdAt: base + 120,
    },
  ];
  if (run.status === "partial" || run.status === "failed") {
    rows.push({
      id: `${run.id}-log-3`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 3,
      level: run.status === "failed" ? "error" : "warn",
      event: "site_aggregation_failed",
      message: "Failed to aggregate a site",
      data: {
        siteId: "demo-site-006",
        error: run.errorMessage ?? "Unknown aggregation failure",
      },
      createdAt: base + 360,
    });
  }
  rows.push(
    {
      id: `${run.id}-log-4`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 4,
      level: "info",
      event: "aggregation_summary",
      message: "Aggregation completed",
      data: {
        status: run.status,
        sitesProcessed: summary.sitesProcessed ?? 0,
        sitesFailed: summary.sitesFailed ?? 0,
        hoursAggregated: summary.hoursAggregated ?? 0,
        rollupRowsWritten: summary.rollupRowsWritten ?? 0,
      },
      createdAt: base + Math.max(420, Math.floor((run.durationMs ?? 0) * 0.72)),
    },
    {
      id: `${run.id}-log-5`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 5,
      level: run.status === "failed" ? "error" : "info",
      event: run.status === "failed" ? "error" : "finish",
      message:
        run.status === "failed"
          ? (run.errorMessage ?? "Task failed")
          : "Task run finished",
      data: {
        status: run.status,
        durationMs: run.durationMs ?? 0,
      },
      createdAt: run.finishedAt ?? base,
    },
  );
  return rows.sort((left, right) => left.sequence - right.sequence);
}

function demoRunGroupKey(run: ScheduledTaskRun): string {
  return run.scheduledAt !== null
    ? `${run.triggerType}:${run.scheduledAt}`
    : run.invocationId;
}

function demoAggregateRunSummary(
  runs: ScheduledTaskRun[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.summary)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      summary[key] = Number(summary[key] ?? 0) + value;
    }
  }
  return summary;
}

function demoGroupStatus(runs: ScheduledTaskRun[]): ScheduledTaskStatus {
  if (runs.some((run) => run.status === "failed")) return "failed";
  if (runs.some((run) => run.status === "running")) return "running";
  if (runs.some((run) => run.status === "partial")) return "partial";
  const skipped = runs.filter((run) => run.status === "skipped").length;
  if (skipped === runs.length) return "skipped";
  if (skipped > 0) return "partial";
  return "success";
}

function demoScheduledRunGroups(
  runs: ScheduledTaskRun[],
): ScheduledTaskRunGroup[] {
  const grouped = new Map<string, ScheduledTaskRun[]>();
  for (const run of runs) {
    const key = demoRunGroupKey(run);
    const groupRuns = grouped.get(key) ?? [];
    groupRuns.push(run);
    grouped.set(key, groupRuns);
  }
  return Array.from(grouped.entries())
    .map(([id, groupRuns]) => {
      const orderedRuns = [...groupRuns].sort(
        (left, right) =>
          left.startedAt - right.startedAt ||
          left.taskKey.localeCompare(right.taskKey),
      );
      const startedAt = Math.min(...orderedRuns.map((run) => run.startedAt));
      const finishedValues = orderedRuns.map((run) => run.finishedAt);
      const finishedAt = finishedValues.some((value) => value === null)
        ? null
        : Math.max(...(finishedValues as number[]));
      return {
        id,
        triggerType: orderedRuns[0]?.triggerType ?? "cron",
        status: demoGroupStatus(orderedRuns),
        scheduledAt: orderedRuns[0]?.scheduledAt ?? null,
        startedAt,
        finishedAt,
        durationMs:
          finishedAt === null ? null : Math.max(0, finishedAt - startedAt),
        taskCount: orderedRuns.length,
        successCount: countByStatus(orderedRuns, "success"),
        partialCount: countByStatus(orderedRuns, "partial"),
        failedCount: countByStatus(orderedRuns, "failed"),
        skippedCount: countByStatus(orderedRuns, "skipped"),
        runningCount: countByStatus(orderedRuns, "running"),
        logsCount: orderedRuns.reduce(
          (count, run) => count + demoScheduledLogs(run).length,
          0,
        ),
        summary: demoAggregateRunSummary(orderedRuns),
        runs: orderedRuns,
      };
    })
    .sort((left, right) => right.startedAt - left.startedAt);
}

function countByStatus(runs: ScheduledTaskRun[], status: ScheduledTaskStatus) {
  return runs.filter((run) => run.status === status).length;
}

function demoTaskSummary(
  definition: (typeof DEMO_SCHEDULED_TASK_DEFINITIONS)[number],
  runs: ScheduledTaskRun[],
): ScheduledTaskSummary {
  const taskRuns = runs.filter((run) => run.taskKey === definition.key);
  const success30d = countByStatus(taskRuns, "success");
  const durations = taskRuns
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === "number");
  return {
    ...definition,
    lastRun: taskRuns[0] ?? null,
    runs30d: taskRuns.length,
    success30d,
    partial30d: countByStatus(taskRuns, "partial"),
    failed30d: countByStatus(taskRuns, "failed"),
    skipped30d: countByStatus(taskRuns, "skipped"),
    running: countByStatus(taskRuns, "running"),
    successRate30d: taskRuns.length > 0 ? success30d / taskRuns.length : null,
    avgDurationMs:
      durations.length > 0
        ? durations.reduce((sum, value) => sum + value, 0) / durations.length
        : null,
  };
}

function parseDemoScheduledTaskLimit(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function generateDemoScheduledTasks(
  params: Record<string, string | number>,
): ScheduledTasksData {
  const now = Date.now();
  const allRuns = demoScheduledRuns(now);
  const status = String(params.status || "");
  const page = parseDemoScheduledTaskLimit(params.page, 1, 1, 10_000);
  const pageSize = parseDemoScheduledTaskLimit(
    params.pageSize ?? params.limit,
    50,
    1,
    100,
  );
  const filteredRuns = demoScheduledRunGroups(allRuns).filter(
    (run) => !status || run.status === status,
  );
  const offset = (page - 1) * pageSize;
  const requestedRuns = filteredRuns.slice(offset, offset + pageSize + 1);
  const hasMore = requestedRuns.length > pageSize;
  const runs = requestedRuns.slice(0, pageSize);
  const requestedRunId = String(params.runId || "");
  const selectedRun =
    (requestedRunId
      ? (filteredRuns.find((run) => run.id === requestedRunId) ??
        filteredRuns.find((group) =>
          group.runs.some((run) => run.id === requestedRunId),
        ) ??
        null)
      : runs[0]) ?? null;
  const runs24h = allRuns.filter(
    (run) => run.startedAt >= now - 24 * 60 * 60 * 1000,
  );
  const success24h = countByStatus(runs24h, "success");
  return {
    ok: true,
    generatedAt: now,
    retentionDays: SCHEDULED_TASK_LOG_RETENTION_DAYS,
    tasks: DEMO_SCHEDULED_TASK_DEFINITIONS.map((task) =>
      demoTaskSummary(task, allRuns),
    ),
    runs,
    runsMeta: {
      page,
      pageSize,
      returned: runs.length,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    },
    selectedRun,
    logs: selectedRun
      ? selectedRun.runs.flatMap((run) => demoScheduledLogs(run))
      : [],
    health: {
      totalRuns24h: runs24h.length,
      failedRuns24h: countByStatus(runs24h, "failed"),
      partialRuns24h: countByStatus(runs24h, "partial"),
      runningRuns: countByStatus(runs24h, "running"),
      staleRunningRuns: 0,
      successRate24h: runs24h.length > 0 ? success24h / runs24h.length : null,
      lastRunAt: allRuns[0]?.startedAt ?? null,
    },
  };
}

const DEMO_SYSTEM_WINDOW_OPTIONS = [15, 60, 360, 1440] as const;
const DEMO_SYSTEM_DELAYED_EVENT_MS = 5 * 60 * 1000;
const DEMO_SYSTEM_FUTURE_SKEW_MS = 30 * 1000;
const DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS = 24 * 60 * 60 * 1000;
const DEMO_SYSTEM_STALE_OPEN_VISIT_MS = 30 * 60 * 1000;
const DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS = 12 * 60 * 60 * 1000;

interface DemoSystemEvent {
  kind: "visit" | "custom_event";
  siteId: string;
  siteName: string;
  siteDomain: string;
  eventAt: number;
  serverAt: number;
  latencyMs: number;
}

function parseDemoSystemPerformanceWindow(
  params: Record<string, string | number>,
): SystemPerformanceWindowMinutes {
  const value = Number(params.minutes || 60);
  return DEMO_SYSTEM_WINDOW_OPTIONS.includes(
    value as SystemPerformanceWindowMinutes,
  )
    ? (value as SystemPerformanceWindowMinutes)
    : 60;
}

function demoSystemBucketSizeMs(
  minutes: SystemPerformanceWindowMinutes,
): number {
  if (minutes <= 15) return 60 * 1000;
  if (minutes <= 60) return 5 * 60 * 1000;
  if (minutes <= 360) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function demoSystemLatencyMs(rng: () => number): number {
  const roll = rng();
  if (roll < 0.012) {
    return sInt(rng, DEMO_SYSTEM_DELAYED_EVENT_MS, 18 * 60 * 1000);
  }
  if (roll < 0.02) {
    return -sInt(rng, DEMO_SYSTEM_FUTURE_SKEW_MS, 4 * 60 * 1000);
  }
  const fastPath = sInt(rng, 90, 850);
  const queueDelay = rng() < 0.16 ? sInt(rng, 850, 6500) : 0;
  const beaconDelay = rng() < 0.05 ? sInt(rng, 6500, 90 * 1000) : 0;
  return fastPath + queueDelay + beaconDelay;
}

function percentileNumber(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * percentile) - 1),
  );
  return ordered[index];
}

export function generateDemoSystemPerformance(
  params: Record<string, string | number>,
): SystemPerformanceData {
  const minutes = parseDemoSystemPerformanceWindow(params);
  const generatedAt = Date.now();
  const from = generatedAt - minutes * 60 * 1000;
  const bucketSizeMs = demoSystemBucketSizeMs(minutes);
  const firstBucket = Math.floor(from / bucketSizeMs) * bucketSizeMs;
  const events: DemoSystemEvent[] = [];

  for (
    let bucketStart = firstBucket;
    bucketStart <= generatedAt;
    bucketStart += bucketSizeMs
  ) {
    const bucketEnd = Math.min(bucketStart + bucketSizeMs, generatedAt);
    if (bucketEnd <= from) continue;
    for (const site of DEMO_SITE_PROFILES) {
      const bucketSeed = `${site.id}:system:${bucketStart}:${minutes}`;
      const rng = mulberry32(fnv1a(bucketSeed));
      const rawViews = integrateViews(site.id, bucketStart, bucketEnd);
      const visits = Math.max(0, Math.round(rawViews * 0.32));
      const customEvents = Math.max(
        0,
        Math.round(visits * sFloat(rng, 0.06, 0.18)),
      );

      for (let index = 0; index < visits + customEvents; index += 1) {
        const isCustom = index >= visits;
        const eventRng = mulberry32(fnv1a(`${bucketSeed}:${index}`));
        const serverAt = Math.min(
          generatedAt,
          bucketStart +
            Math.floor(eventRng() * Math.max(1, bucketEnd - bucketStart)),
        );
        const latencyMs = demoSystemLatencyMs(eventRng);
        events.push({
          kind: isCustom ? "custom_event" : "visit",
          siteId: site.id,
          siteName: site.name,
          siteDomain: site.domain,
          eventAt: serverAt - latencyMs,
          serverAt,
          latencyMs,
        });
      }
    }
  }

  const trustedLatencies = events
    .map((event) => event.latencyMs)
    .filter(
      (value) => value >= 0 && value <= DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS,
    );
  const totalEvents = events.length;
  const visits = events.filter((event) => event.kind === "visit").length;
  const customEvents = totalEvents - visits;
  const delayedEvents = events.filter(
    (event) => event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS,
  ).length;
  const futureSkewedEvents = events.filter(
    (event) => event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS,
  ).length;
  const latestCreatedAt =
    events.length > 0
      ? Math.max(...events.map((event) => event.serverAt))
      : null;

  const trendMap = new Map<number, SystemPerformanceTrendPoint>();
  const siteMap = new Map<string, SystemPerformanceTopSite>();
  const siteLatencyMap = new Map<string, number[]>();

  for (const event of events) {
    const bucket = Math.floor(event.serverAt / bucketSizeMs) * bucketSizeMs;
    const trend = trendMap.get(bucket) ?? {
      bucket: Math.floor(bucket / 1000),
      timestampMs: bucket,
      visits: 0,
      customEvents: 0,
      totalEvents: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      delayedEvents: 0,
      futureSkewedEvents: 0,
    };
    if (event.kind === "visit") trend.visits += 1;
    else trend.customEvents += 1;
    trend.totalEvents += 1;
    if (event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS) {
      trend.delayedEvents += 1;
    }
    if (event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS) {
      trend.futureSkewedEvents += 1;
    }
    trendMap.set(bucket, trend);

    const site = siteMap.get(event.siteId) ?? {
      siteId: event.siteId,
      siteName: event.siteName,
      siteDomain: event.siteDomain,
      totalEvents: 0,
      visits: 0,
      customEvents: 0,
      avgLatencyMs: null,
      delayedEvents: 0,
      futureSkewedEvents: 0,
    };
    site.totalEvents += 1;
    if (event.kind === "visit") site.visits += 1;
    else site.customEvents += 1;
    if (event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS) {
      site.delayedEvents += 1;
    }
    if (event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS) {
      site.futureSkewedEvents += 1;
    }
    siteMap.set(event.siteId, site);
    if (
      event.latencyMs >= 0 &&
      event.latencyMs <= DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS
    ) {
      const latencies = siteLatencyMap.get(event.siteId) ?? [];
      latencies.push(event.latencyMs);
      siteLatencyMap.set(event.siteId, latencies);
    }
  }

  for (const [siteId, site] of siteMap.entries()) {
    const latencies = siteLatencyMap.get(siteId) ?? [];
    site.avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null;
  }

  const trendLatencyMap = new Map<number, number[]>();
  for (const event of events) {
    if (
      event.latencyMs < 0 ||
      event.latencyMs > DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS
    ) {
      continue;
    }
    const bucket = Math.floor(event.serverAt / bucketSizeMs) * bucketSizeMs;
    const latencies = trendLatencyMap.get(bucket) ?? [];
    latencies.push(event.latencyMs);
    trendLatencyMap.set(bucket, latencies);
  }
  for (const [bucket, trend] of trendMap.entries()) {
    const latencies = trendLatencyMap.get(bucket) ?? [];
    trend.avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null;
    trend.p50LatencyMs = percentileNumber(latencies, 0.5);
    trend.p75LatencyMs = percentileNumber(latencies, 0.75);
    trend.p95LatencyMs = percentileNumber(latencies, 0.95);
  }

  const openTotal = Math.max(
    1,
    Math.round(
      integrateViews(
        "demo-site-001",
        generatedAt - 5 * 60 * 1000,
        generatedAt,
      ) * 0.18,
    ),
  );
  const stale = Math.max(0, Math.round(openTotal * 0.08));
  const timedOut = Math.max(0, Math.round(openTotal * 0.015));
  const dataFreshnessMs =
    latestCreatedAt === null
      ? null
      : Math.max(0, generatedAt - latestCreatedAt);

  return {
    ok: true,
    generatedAt,
    window: {
      from,
      to: generatedAt,
      minutes,
      bucketSizeMs,
    },
    thresholds: {
      delayedMs: DEMO_SYSTEM_DELAYED_EVENT_MS,
      futureSkewMs: DEMO_SYSTEM_FUTURE_SKEW_MS,
      trustedLatencyMaxMs: DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS,
      staleOpenVisitMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
      timedOutOpenVisitMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
    },
    summary: {
      totalEvents,
      visits,
      customEvents,
      activeSites: new Set(events.map((event) => event.siteId)).size,
      eventsPerMinute: totalEvents / minutes,
      latestCreatedAt,
      dataFreshnessMs,
      avgLatencyMs:
        trustedLatencies.length > 0
          ? trustedLatencies.reduce((sum, value) => sum + value, 0) /
            trustedLatencies.length
          : null,
      p50LatencyMs: percentileNumber(trustedLatencies, 0.5),
      p75LatencyMs: percentileNumber(trustedLatencies, 0.75),
      p95LatencyMs: percentileNumber(trustedLatencies, 0.95),
      trustedLatencySamples: trustedLatencies.length,
      delayedEvents,
      futureSkewedEvents,
      anomalyRate:
        totalEvents > 0
          ? (delayedEvents + futureSkewedEvents) / totalEvents
          : 0,
    },
    openVisits: {
      total: openTotal,
      stale,
      timedOut,
      oldestStartedAt:
        openTotal > 0
          ? generatedAt -
            sInt(mulberry32(fnv1a("system:oldest-open")), 8, 150) * 60 * 1000
          : null,
      newestActivityAt:
        openTotal > 0
          ? generatedAt -
            sInt(mulberry32(fnv1a("system:newest-activity")), 5, 90) * 1000
          : null,
    },
    trend: Array.from(trendMap.values()).sort(
      (left, right) => left.timestampMs - right.timestampMs,
    ),
    topSites: Array.from(siteMap.values())
      .sort(
        (left, right) =>
          right.totalEvents - left.totalEvents ||
          right.delayedEvents - left.delayedEvents,
      )
      .slice(0, 8),
    slowEvents: events
      .filter((event) => event.latencyMs > 0)
      .sort((left, right) => right.latencyMs - left.latencyMs)
      .slice(0, 10)
      .map(
        (event): SystemPerformanceSlowEvent => ({
          kind: event.kind,
          siteId: event.siteId,
          siteName: event.siteName,
          siteDomain: event.siteDomain,
          eventAt: event.eventAt,
          serverAt: event.serverAt,
          latencyMs: event.latencyMs,
        }),
      ),
  };
}

const DEMO_DO_HARD_AGED_MS = 36 * 60 * 60 * 1000;
const DEMO_DO_STUCK_FLUSH_ATTEMPTS = 5;

export function generateDemoDoDiagnostic(): DoDiagnosticAggregate {
  const generatedAt = Date.now();
  const sites: DoDiagnosticSiteEntry[] = DEMO_SITE_PROFILES.slice(0, 12).map(
    (site, index) => {
      const rng = mulberry32(fnv1a(`do-diag:${site.id}:${index}`));
      const openTotal = Math.floor(rng() * 30);
      const stale = Math.min(openTotal, Math.floor(rng() * 12));
      const timedOut = Math.min(stale, Math.floor(rng() * 4));
      const hardAged = index === 0 ? Math.floor(rng() * 3) : 0;
      const futureSkewed = index === 1 ? Math.floor(rng() * 2) : 0;
      const dirty = Math.floor(rng() * 8);
      const stuck = index < 2 ? Math.floor(rng() * 2) : 0;
      const customEventsTotal = Math.floor(rng() * 40);
      const customEventsDirty = Math.floor(rng() * 6);
      return {
        siteId: site.id,
        siteName: site.name,
        siteDomain: site.domain,
        ok: true,
        durationMs: Math.round(40 + rng() * 80),
        diagnostic: {
          ok: true,
          snapshotAt: generatedAt,
          thresholds: {
            staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
            timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
            hardAgedMs: DEMO_DO_HARD_AGED_MS,
            stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
          },
          visits: {
            total: openTotal + Math.floor(rng() * 60),
            byStatus: { open: openTotal },
            open: {
              total: openTotal,
              stale,
              timedOut,
              hardAged,
              futureSkewed,
              oldestStartedAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 12 * 60 * 60 * 1000)
                  : null,
              newestActivityAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 60 * 1000)
                  : null,
              futureMaxActivityAt:
                futureSkewed > 0
                  ? generatedAt + Math.floor(rng() * 24 * 60 * 60 * 1000)
                  : null,
            },
            dirty: {
              total: dirty,
              stuck,
              maxFlushAttempts:
                stuck > 0 ? Math.floor(5 + rng() * 20) : Math.floor(rng() * 3),
            },
          },
          customEvents: {
            total: customEventsTotal,
            dirty: customEventsDirty,
            stuck: 0,
            maxFlushAttempts: Math.floor(rng() * 3),
            oldestOccurredAt:
              customEventsDirty > 0
                ? generatedAt - Math.floor(rng() * 30 * 60 * 1000)
                : null,
          },
          alarm: {
            scheduledAt:
              openTotal > 0
                ? generatedAt + Math.floor(rng() * 60 * 1000)
                : null,
            nextDueAt:
              openTotal > 0
                ? generatedAt + Math.floor(rng() * 60 * 1000)
                : null,
            nextDueKind: openTotal > 0 ? "visit_timeout" : null,
            nextDueEntity: openTotal > 0 ? "visit" : null,
          },
        },
      };
    },
  );

  const totals = sites.reduce(
    (acc, entry) => {
      const d = entry.diagnostic;
      if (!d) return acc;
      acc.bufferedVisits += d.visits.total;
      acc.openVisits += d.visits.open.total;
      acc.openStale += d.visits.open.stale;
      acc.openTimedOut += d.visits.open.timedOut;
      acc.openHardAged += d.visits.open.hardAged;
      acc.openFutureSkewed += d.visits.open.futureSkewed;
      acc.dirtyVisits += d.visits.dirty.total;
      acc.stuckDirtyVisits += d.visits.dirty.stuck;
      acc.bufferedCustomEvents += d.customEvents.total;
      acc.dirtyCustomEvents += d.customEvents.dirty;
      acc.stuckDirtyCustomEvents += d.customEvents.stuck;
      if (d.alarm.scheduledAt !== null) acc.activeAlarms += 1;
      acc.maxVisitFlushAttempts = Math.max(
        acc.maxVisitFlushAttempts,
        d.visits.dirty.maxFlushAttempts,
      );
      acc.maxCustomEventFlushAttempts = Math.max(
        acc.maxCustomEventFlushAttempts,
        d.customEvents.maxFlushAttempts,
      );
      return acc;
    },
    {
      bufferedVisits: 0,
      openVisits: 0,
      openStale: 0,
      openTimedOut: 0,
      openHardAged: 0,
      openFutureSkewed: 0,
      dirtyVisits: 0,
      stuckDirtyVisits: 0,
      bufferedCustomEvents: 0,
      dirtyCustomEvents: 0,
      stuckDirtyCustomEvents: 0,
      activeAlarms: 0,
      maxVisitFlushAttempts: 0,
      maxCustomEventFlushAttempts: 0,
    },
  );

  const oldestOpenStartedAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.oldestStartedAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value < acc ? value : acc;
  }, null);
  const futureMaxActivityAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.futureMaxActivityAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value > acc ? value : acc;
  }, null);

  return {
    ok: true,
    generatedAt,
    totalSites: sites.length,
    reachableSites: sites.length,
    unreachableSites: 0,
    thresholds: {
      staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
      timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
      hardAgedMs: DEMO_DO_HARD_AGED_MS,
      stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
    },
    totals,
    oldestOpenStartedAt,
    futureMaxActivityAt,
    sites,
  };
}
