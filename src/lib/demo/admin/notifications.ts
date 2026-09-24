import type {
  NotificationMessageData,
  NotificationRuleData,
} from "@/lib/dashboard-api/contract/types/admin";
import { isValidLocale, type Locale } from "@/lib/i18n/config";
import { buildNotificationContent } from "@/lib/notifications/content";
import { renderNotificationPlainText } from "@/lib/notifications/email-text";
import type { NotificationMessage } from "@/lib/notifications/message";
import type {
  NotificationMessageType,
  NotificationSeverity,
} from "@/lib/notifications/message-types";

import {
  getDemoSites,
  getDemoTeams,
  getDemoUser,
  nextHourSeconds,
  nowSeconds,
} from "./users";
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
