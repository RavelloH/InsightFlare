import type { Locale } from "@/lib/i18n/config";
import type { NotificationMessage } from "@/lib/notifications/message";

function baseMessage(
  input: Partial<NotificationMessage> & Pick<NotificationMessage, "type">,
): NotificationMessage {
  return {
    id: `preview-${input.type}`,
    teamId: "team-preview",
    siteId: "site-preview",
    userId: "user-preview",
    ruleId: "rule-preview",
    runId: null,
    batchId: "batch-preview",
    type: input.type,
    severity: input.severity ?? "info",
    requiresAttention: input.requiresAttention ?? false,
    title: input.title ?? "InsightFlare notification",
    summary: input.summary ?? "Preview notification",
    bodyText: input.bodyText ?? "Preview notification body.",
    bodyHtml: "",
    data: { locale: "en", ...(input.data ?? {}) },
    channels: { inApp: true },
    deliveryStatus: "created",
    deliveryResults: {},
    errorMessage: "",
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: 1782691200,
    createdAt: 1782691200,
    updatedAt: 1782691200,
    sentAt: null,
    failedAt: null,
    expiresAt: null,
  };
}

export const notificationEmailPreviewMessages = {
  test: baseMessage({
    type: "test",
    title: "InsightFlare notification test",
    summary: "This is a test notification from InsightFlare.",
    bodyText:
      "This is a test notification from InsightFlare. If email is configured and enabled, this message also verifies Resend delivery.",
    data: { source: "preview", locale: "en" },
  }),
  report: baseMessage({
    type: "report",
    title: "example.com daily traffic report",
    data: {
      siteDomain: "example.com",
      range: { label: "2026-06-29" },
      metrics: { views: 3820, visitors: 1240, sessions: 1510 },
      topPages: [
        { path: "/", views: 1200 },
        { path: "/pricing", views: 420 },
      ],
      topReferrers: [
        { referrer: "Google", visits: 520 },
        { referrer: "Direct", visits: 160 },
      ],
      locale: "en",
    },
  }),
  threshold: baseMessage({
    type: "threshold",
    severity: "warning",
    requiresAttention: true,
    data: {
      siteDomain: "example.com",
      metric: "visitors",
      window: "last_1h",
      value: 1240,
      operator: ">=",
      target: 1000,
      locale: "en",
    },
  }),
  milestone: baseMessage({
    type: "milestone",
    severity: "success",
    data: {
      siteDomain: "example.com",
      metric: "visitors",
      value: 50240,
      step: 10000,
      bucket: 50000,
      locale: "en",
    },
  }),
  change: baseMessage({
    type: "change",
    severity: "warning",
    requiresAttention: true,
    data: {
      siteDomain: "example.com",
      metric: "visitors",
      window: "last_24h",
      current: 1860,
      previous: 920,
      change: 102.1,
      mode: "percent",
      locale: "en",
    },
  }),
  health: baseMessage({
    type: "health",
    severity: "critical",
    requiresAttention: true,
    data: {
      siteDomain: "example.com",
      hours: 12,
      lastSeenAt: 1782793800,
      locale: "en",
    },
  }),
};

export type NotificationEmailPreviewType =
  keyof typeof notificationEmailPreviewMessages;

export function notificationEmailPreviewMessage(
  type: NotificationEmailPreviewType,
  locale: Locale,
): NotificationMessage {
  const message = notificationEmailPreviewMessages[type];
  return {
    ...message,
    data: {
      ...message.data,
      locale,
    },
  };
}
