import type {
  NotificationMessageData,
  NotificationRuleData,
  NotificationRuleEvaluationData,
  NotificationRuleRunData,
} from "@/lib/dashboard-api/contract/types/admin";
import { generateDemoNotificationRules } from "@/lib/demo/admin/notifications";
import {
  getDemoSites,
  getDemoTeams,
  getDemoUser,
} from "@/lib/demo/admin/users";
import type { Locale } from "@/lib/i18n/config";
import {
  buildNotificationContent,
  notificationSiteName,
} from "@/lib/notifications/content";
import { renderNotificationPlainText } from "@/lib/notifications/email-text";
import type { NotificationMessage } from "@/lib/notifications/message";
import type {
  NotificationMessageType,
  NotificationSeverity,
} from "@/lib/notifications/message-types";
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
function requestRuleId(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const raw = body as { id?: unknown; ruleId?: unknown };
  return String(raw.ruleId || raw.id || "").trim();
}
function findDemoNotificationRule(ruleId: string): NotificationRuleData {
  const teams = getDemoTeams();
  for (const team of teams) {
    const rule = generateDemoNotificationRules(team.id).find(
      (item) => item.id === ruleId,
    );
    if (rule) return rule;
  }
  return generateDemoNotificationRules(teams[0]?.id || "")[0]!;
}
export function demoLocale(value: unknown): Locale {
  return value === "zh" ? "zh" : "en";
}
function demoSiteDomain(siteId: string | null | undefined): string {
  if (!siteId) return "demo.insightflare.net";
  for (const team of getDemoTeams()) {
    const site = getDemoSites(team.id).find((item) => item.id === siteId);
    if (site) return site.domain;
  }
  return "demo.insightflare.net";
}
function escapeDemoNotificationHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function demoNotificationBodyHtml(input: {
  title: string;
  summary: string;
  bodyText: string;
}): string {
  const paragraphs = input.bodyText
    .split("\n")
    .filter((line) => line.trim())
    .map(
      (line) =>
        `<p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:1.7">${escapeDemoNotificationHtml(line)}</p>`,
    )
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>',
    '<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#0f172a">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:28px 14px"><tr><td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0">',
    '<tr><td style="padding:28px 28px 20px;border-bottom:1px solid #e2e8f0">',
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:10px">InsightFlare</div>',
    `<h1 style="margin:0;color:#0f172a;font-size:22px;line-height:1.3;font-weight:650">${escapeDemoNotificationHtml(input.title)}</h1>`,
    `<p style="margin:12px 0 0;color:#475569;font-size:14px;line-height:1.6">${escapeDemoNotificationHtml(input.summary)}</p>`,
    "</td></tr>",
    `<tr><td style="padding:24px 28px">${paragraphs}</td></tr>`,
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("");
}
function demoRuleMessage(input: {
  type: NotificationMessageType;
  severity: NotificationSeverity;
  requiresAttention: boolean;
  data: Record<string, unknown>;
  locale: Locale;
}) {
  const content = buildNotificationContent({
    type: input.type,
    severity: input.severity,
    data: input.data,
    locale: input.locale,
  });
  const data = {
    ...input.data,
    locale: input.locale,
  };
  const bodyText = renderNotificationPlainText({
    content,
    locale: input.locale,
    message: {
      id: "demo-preview-message",
      teamId: "demo-team",
      siteId: null,
      userId: "demo-user",
      ruleId: null,
      runId: null,
      batchId: null,
      type: input.type,
      severity: input.severity,
      requiresAttention: input.requiresAttention,
      data,
      title: content.title,
      summary: content.summary,
      bodyText: content.bodyText,
      bodyHtml: "",
      channels: { inApp: true, email: true },
      deliveryStatus: "sent",
      deliveryResults: {},
      errorMessage: "",
      readAt: null,
      dismissedAt: null,
      archivedAt: null,
      triggeredAt: null,
      createdAt: 0,
      updatedAt: 0,
      sentAt: null,
      failedAt: null,
      expiresAt: null,
    } satisfies NotificationMessage,
  });
  return {
    type: input.type,
    severity: input.severity,
    requiresAttention: input.requiresAttention,
    title: content.title,
    summary: content.summary,
    bodyText,
    bodyHtml: demoNotificationBodyHtml(content),
    data,
  };
}
function demoRuleEvaluation(
  rule: NotificationRuleData,
  locale: Locale = "en",
): NotificationRuleEvaluationData {
  const condition = rule.condition || {};
  const siteDomain = notificationSiteName({
    siteDomain: demoSiteDomain(rule.siteId),
  });
  if (!rule.enabled) {
    return {
      status: "skipped",
      reason: "Demo rule is disabled.",
      data: { ruleId: rule.id, type: rule.type },
    };
  }

  if (rule.type === "report") {
    const data = {
      ruleId: rule.id,
      siteDomain,
      reportType: condition.reportType || "daily",
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
    };
    return {
      status: "triggered",
      message: demoRuleMessage({
        type: "report",
        severity: "info",
        requiresAttention: false,
        data,
        locale,
      }),
      data: { ruleId: rule.id, type: rule.type },
    };
  }

  if (rule.type === "health") {
    const data = {
      ruleId: rule.id,
      siteDomain,
      check: condition.check || "no_data",
      hours: condition.hours || 6,
      lastSeenAt: nowSeconds() - Number(condition.hours || 6) * 3600,
    };
    return {
      status: "triggered",
      message: demoRuleMessage({
        type: "health",
        severity: "critical",
        requiresAttention: true,
        data,
        locale,
      }),
      cooldownUntil:
        Number(condition.cooldownMinutes || 0) > 0
          ? nowSeconds() + Number(condition.cooldownMinutes) * 60
          : null,
      data: { ruleId: rule.id, type: rule.type },
    };
  }

  if (rule.type === "threshold") {
    const target = Number(condition.value || 120);
    const currentValue =
      condition.operator === "<" || condition.operator === "<=" ? 84 : 1428;
    const severity = condition.operator === "<" ? "critical" : "warning";
    const data = {
      ruleId: rule.id,
      siteDomain,
      metric: condition.metric || "sessions",
      window: condition.window || "last_1h",
      operator: condition.operator || "<",
      value: currentValue,
      target,
    };
    return {
      status: "triggered",
      message: demoRuleMessage({
        type: "threshold",
        severity,
        requiresAttention: true,
        data,
        locale,
      }),
      cooldownUntil:
        Number(condition.cooldownMinutes || 0) > 0
          ? nowSeconds() + Number(condition.cooldownMinutes) * 60
          : null,
      data: { ruleId: rule.id, type: rule.type, value: currentValue, target },
    };
  }

  return {
    status: "triggered",
    message: demoRuleMessage({
      type: "test",
      severity: "info",
      requiresAttention: false,
      data: { ruleId: rule.id, source: "demo_rule_preview" },
      locale,
    }),
    data: { ruleId: rule.id, type: rule.type },
  };
}
function demoRunMessage(
  rule: NotificationRuleData,
  evaluation: NotificationRuleEvaluationData,
): NotificationMessageData[] {
  if (evaluation.status !== "triggered") return [];
  const now = nowSeconds();
  const message = evaluation.message;
  return [
    {
      id: `demo-notification-run-${rule.id}-${now}`,
      teamId: rule.teamId,
      siteId: rule.siteId,
      userId: getDemoUser().id,
      ruleId: rule.id,
      runId: `demo-run-${now}`,
      batchId: `demo-batch-${now}`,
      type: message.type,
      severity: message.severity,
      requiresAttention: message.requiresAttention,
      title: message.title,
      summary: message.summary,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml || "",
      data: message.data || {},
      channels: { inApp: true, email: true },
      deliveryStatus: "sent",
      deliveryResults: {
        inApp: { status: "sent" },
        email: { status: "skipped", reason: "system_email_unconfigured" },
      },
      errorMessage: "",
      readAt: null,
      dismissedAt: null,
      archivedAt: null,
      triggeredAt: now,
      createdAt: now,
      updatedAt: now,
      sentAt: now,
      failedAt: null,
      expiresAt: now + 30 * 24 * 60 * 60,
    },
  ];
}
export function generateDemoNotificationRulePreview(
  body: unknown,
): NotificationRuleEvaluationData {
  const locale =
    body && typeof body === "object"
      ? demoLocale((body as Record<string, unknown>).locale)
      : "en";
  return demoRuleEvaluation(
    findDemoNotificationRule(requestRuleId(body)),
    locale,
  );
}
export function generateDemoNotificationRuleRun(
  body: unknown,
): NotificationRuleRunData {
  const rule = findDemoNotificationRule(requestRuleId(body));
  const locale =
    body && typeof body === "object"
      ? demoLocale((body as Record<string, unknown>).locale)
      : "en";
  const evaluation = demoRuleEvaluation(rule, locale);
  const messages = demoRunMessage(rule, evaluation);
  return {
    evaluation,
    messages,
    messageCount: messages.length,
    summary: {
      rulesScanned: 1,
      rulesChecked: evaluation.status === "skipped" ? 0 : 1,
      rulesTriggered: evaluation.status === "triggered" ? 1 : 0,
      rulesSkipped: evaluation.status === "skipped" ? 1 : 0,
      messagesCreated: messages.length,
      emailSent: 0,
      emailFailed: 0,
      durationMs: 24,
    },
  };
}
