import {
  defaultBotAnalyticsConfig,
  redactBotAnalyticsConfig,
} from "@/lib/bot-analytics-config";
import { normalizeTimeZone } from "@/lib/dashboard/time-zone";
import type { NotificationPreferencesData } from "@/lib/edge-client";
import type {
  NotificationMessageData,
  NotificationRuleData,
  NotificationRuleEvaluationData,
  NotificationRuleRunData,
} from "@/lib/edge-client-types/admin";
import type { Locale } from "@/lib/i18n/config";
import {
  buildNotificationContent,
  notificationSiteName,
} from "@/lib/notifications/content";
import {
  defaultNotificationEmailConfig,
  redactNotificationEmailConfig,
} from "@/lib/notifications/email-config";
import { renderNotificationPlainText } from "@/lib/notifications/email-text";
import type { NotificationMessage } from "@/lib/notifications/message-store";
import type {
  NotificationMessageType,
  NotificationSeverity,
} from "@/lib/notifications/message-types";
import { findSiteProfileByPublicSlug } from "@/lib/realtime/demo-site-profiles";
import {
  createDemoNotificationRule,
  generateDemoApiKeys,
  generateDemoDoDiagnostic,
  generateDemoNotificationMessages,
  generateDemoNotificationRules,
  generateDemoNotificationTest,
  generateDemoScheduledTasks,
  generateDemoSystemPerformance,
  generateDemoTeamInvites,
  getDemoMembers,
  getDemoScriptSnippet,
  getDemoSiteConfig,
  getDemoSites,
  getDemoTeams,
  getDemoUser,
  getDemoUsers,
} from "@/lib/realtime/mock/admin";
import {
  generateDemoDimension,
  generateDemoOverview,
  generateDemoPages,
  generateDemoPagesDashboard,
  generateDemoPerformance,
  generateDemoReferrers,
  generateDemoRetention,
  generateDemoTrend,
} from "@/lib/realtime/mock/analytics";
import {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar,
} from "@/lib/realtime/mock/browser-client";
import {
  demoBadRequest,
  demoNotFound,
  demoOk,
  extractErrorMessage,
  isErrorEnvelope,
} from "@/lib/realtime/mock/envelope";
import {
  generateDemoEventFields,
  generateDemoEventRecordDetail,
  generateDemoEventsRecords,
  generateDemoEventsSummary,
  generateDemoEventsTrend,
  generateDemoEventTypeDetail,
  generateDemoEventTypeFieldValues,
} from "@/lib/realtime/mock/events";
import {
  createDemoFunnel,
  deleteDemoFunnel,
  generateDemoFunnels,
} from "@/lib/realtime/mock/funnels";
import {
  generateDemoSessionDetail,
  generateDemoSessions,
  generateDemoVisitorDetail,
  generateDemoVisitors,
} from "@/lib/realtime/mock/journeys";
import { generateDemoRequestObservationData } from "@/lib/realtime/mock/request-observation";
import { handleDemoSavedFilters } from "@/lib/realtime/mock/saved-filters";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoClientDimensionTrend,
  generateDemoReferrerTrend,
} from "@/lib/realtime/mock/share-trends";
import { generateDemoTeamDashboard } from "@/lib/realtime/mock/team-dashboard";
import {
  generateDemoFilterValues,
  generateDemoGeoPoints,
  generateDemoOverviewClientTab,
  generateDemoOverviewGeoTab,
  generateDemoOverviewPageTab,
  generateDemoOverviewSourceTab,
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/realtime/mock/utm-overview";

// ---------------------------------------------------------------------------
//  Realtime mock socket
// ---------------------------------------------------------------------------

export type { RealtimeSocketLike } from "@/lib/realtime/mock/socket";
export { createMockRealtimeSocket } from "@/lib/realtime/mock/socket";

const demoNotFoundResponse = () => demoNotFound();

const demoNotificationPreferences: NotificationPreferencesData = {
  inApp: true,
  email: true,
  webPush: false,
  attention: {
    reportsCreateUnread: false,
    milestonesCreateUnread: false,
    alertsCreateUnread: true,
  },
};

function nowSeconds(): number {
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

function demoLocale(value: unknown): Locale {
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

function demoLoginTurnstileConfig(body?: Record<string, unknown>) {
  const secretKey =
    typeof body?.secretKey === "string" && body.secretKey.trim().length > 0
      ? body.secretKey.trim()
      : "";
  const configured = secretKey.length > 0;
  return {
    enabled: typeof body?.enabled === "boolean" ? body.enabled : false,
    siteKey: typeof body?.siteKey === "string" ? body.siteKey : "",
    mode: "invisible",
    secretKeyConfigured: configured,
    secretKeyHint: configured ? `••••${secretKey.slice(-4)}` : "",
    updatedAt: configured || body ? Date.now() : 0,
  };
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

function generateDemoNotificationRulePreview(
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

function generateDemoNotificationRuleRun(
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

// ---------------------------------------------------------------------------
//  Route dispatcher — the single entry point for demo mode
// ---------------------------------------------------------------------------

function handleDemoRequestInner(options: {
  path: string;
  method?: string;
  params?: Record<string, string | number>;
  body?: unknown;
}): unknown {
  const { path, method = "GET", params = {} } = options;
  const publicRouteMatch = path.match(/\/api\/public\/share\/([^/]+)\//);
  const publicSiteProfile = publicRouteMatch
    ? findSiteProfileByPublicSlug(publicRouteMatch[1] || "")
    : null;
  const apiV1SiteMatch = path.match(/\/api\/v1\/sites\/([^/]+)/);
  const siteId = String(
    params.siteId ||
      apiV1SiteMatch?.[1] ||
      publicSiteProfile?.id ||
      "demo-site-001",
  );
  const teamId = String(params.teamId || "");
  const bodyRecord =
    options.body && typeof options.body === "object"
      ? (options.body as Record<string, unknown>)
      : {};
  const locale = demoLocale(params.locale ?? bodyRecord.locale);

  if (path.startsWith("/api/private/saved-filters")) {
    return handleDemoSavedFilters({ path, method, siteId, body: options.body });
  }

  // Write operations → read-only stub
  if (
    method === "POST" ||
    method === "PATCH" ||
    method === "PUT" ||
    method === "DELETE"
  ) {
    if (path.includes("/admin/bot-analytics-config")) {
      const body = bodyRecord as {
        accountId?: unknown;
        apiToken?: unknown;
        clearApiToken?: unknown;
      };
      const config = defaultBotAnalyticsConfig();
      config.accountId = String(body.accountId ?? "").trim();
      config.configured =
        body.clearApiToken !== true &&
        String(body.apiToken ?? "").trim() !== "";
      config.apiTokenHint = config.configured ? "••••demo" : "";
      config.updatedAt = Date.now();
      return { ok: true, data: redactBotAnalyticsConfig(config) };
    }
    if (path.includes("/funnels")) {
      if (method === "DELETE") return deleteDemoFunnel(siteId, params);
      return createDemoFunnel(siteId, options.body);
    }
    // Special cases that need real-looking responses
    if (path === "/api/public/session" || path.includes("/auth/login")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/auth/me")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/profile")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const profileBody = body as {
        email?: unknown;
        name?: unknown;
        timeZone?: unknown;
        username?: unknown;
      };
      const hasTimeZone = Object.prototype.hasOwnProperty.call(
        body,
        "timeZone",
      );
      const user = getDemoUser();
      return {
        ok: true,
        data: {
          ...user,
          username: String(profileBody.username ?? user.username),
          email: String(profileBody.email ?? user.email),
          name: String(profileBody.name ?? user.name),
          timeZone: hasTimeZone
            ? normalizeTimeZone(String(profileBody.timeZone ?? ""))
            : user.timeZone,
        },
      };
    }
    if (path.includes("/site-config")) {
      const config =
        options.body &&
        typeof options.body === "object" &&
        "config" in options.body &&
        options.body.config &&
        typeof options.body.config === "object"
          ? (options.body.config as Record<string, unknown>)
          : {};
      return {
        ok: true,
        data: {
          ...getDemoSiteConfig(),
          ...config,
        },
      };
    }
    if (path.includes("/admin/notification-email/test")) {
      return {
        ok: true,
        data: {
          provider: "resend",
          messageId: "demo-email-message",
          durationMs: 128,
        },
      };
    }
    if (path.includes("/admin/login-turnstile/test")) {
      return { ok: true, data: { verified: true, hostname: "demo.local" } };
    }
    if (path.includes("/admin/login-turnstile")) {
      if (method === "DELETE") {
        return { ok: true, data: demoLoginTurnstileConfig() };
      }
      return {
        ok: true,
        data: demoLoginTurnstileConfig(bodyRecord),
      };
    }
    if (path.includes("/admin/api-keys")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const keyBody = body as {
        keyId?: unknown;
        name?: unknown;
        scopes?: unknown;
        siteIds?: unknown;
        teamId?: unknown;
      };
      const now = nowSeconds();
      const team = String(keyBody.teamId || teamId || getDemoTeams()[0].id);
      const keys = generateDemoApiKeys(team);
      if (!keyBody.keyId) {
        const createdName = String(keyBody.name ?? "").trim();
        if (createdName.length < 2) return demoBadRequest("name is required");
        if (!Array.isArray(keyBody.scopes) || keyBody.scopes.length === 0) {
          return demoBadRequest("at least one scope is required");
        }
      }
      if (keyBody.keyId) {
        const key = keys.find((item) => item.id === keyBody.keyId);
        if (method === "PATCH") {
          return {
            ok: true,
            data: {
              ...(key ?? {
                id: String(keyBody.keyId),
                teamId: team,
                name: "API key",
                prefix: "",
                scopes: [],
                siteIds: [],
                createdByUserId: "",
                expiresAt: 0,
                revokedAt: null,
                revokedByUserId: "",
                rotatedFromKeyId: "",
                lastUsedAt: null,
                createdAt: now,
                updatedAt: now,
                status: "active",
              }),
              status: "revoked",
              revokedAt: now,
              revokedByUserId: getDemoUser().id,
              updatedAt: now,
            },
          };
        }
      }
      return {
        ok: true,
        data: {
          key: {
            ...keys[0],
            id: `demo-api-key-created-${now}`,
            name: String(keyBody.name || "Demo API key"),
            scopes: Array.isArray(keyBody.scopes)
              ? keyBody.scopes
              : keys[0].scopes,
            siteIds: Array.isArray(keyBody.siteIds) ? keyBody.siteIds : [],
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            status: "active",
          },
          secret: `if_demo_${now.toString(36)}_preview_secret`,
        },
      };
    }
    if (path.includes("/admin/team-invites")) {
      const now = nowSeconds();
      const inviteTeamId = String(
        bodyRecord.teamId || teamId || getDemoTeams()[0].id,
      );
      const rawRole = String(bodyRecord.role || "").toLowerCase();
      if (rawRole && rawRole !== "member" && rawRole !== "admin") {
        return demoBadRequest("Invite role must be member or admin");
      }
      const role = rawRole === "admin" ? "admin" : "member";
      const email = String(bodyRecord.email || "").trim();
      if (!email) return demoBadRequest("A valid email is required");
      const siteIds =
        role === "member" && Array.isArray(bodyRecord.siteIds)
          ? bodyRecord.siteIds
          : [];
      const token = `demo_created_${role}_${now.toString(36)}`;
      return {
        ok: true,
        data: {
          invite: {
            id: `demo-team-invite-created-${now}`,
            type: "team_invite",
            teamId: inviteTeamId,
            userId: "",
            email,
            payload: { teamRole: role, siteIds },
            code: token,
            url: `https://demo.insightflare.net/invite#token=${token}`,
            createdByUserId: getDemoUser().id,
            createdAt: now,
            expiresAt: now + Number(bodyRecord.expiresInHours || 72) * 60 * 60,
            usedAt: null,
            usedByUserId: "",
            revokedAt: null,
            status: "active",
          },
          url: `https://demo.insightflare.net/invite#token=${token}`,
        },
      };
    }
    if (path.includes("/admin/notification-test")) {
      return {
        ok: true,
        data: generateDemoNotificationTest(options.body),
      };
    }
    if (path === "/api/private/notifications") {
      return { ok: true, data: { updated: 1 } };
    }
    if (path === "/api/private/notifications/preferences") {
      return { ok: true, data: demoNotificationPreferences };
    }
    const notificationReadMatch = path.match(
      /^\/api\/private\/notifications\/([^/]+)$/,
    );
    if (notificationReadMatch) {
      const messageId = decodeURIComponent(
        notificationReadMatch[1] || "demo-notification-message-attention",
      );
      const message =
        generateDemoNotificationMessages(
          teamId || getDemoTeams()[0].id,
          locale,
        ).find((item) => item.id === messageId) ?? null;
      return {
        ok: true,
        data: message
          ? { ...message, readAt: Math.floor(Date.now() / 1000) }
          : null,
      };
    }
    if (path.includes("/admin/notification-rules")) {
      if (path.includes("/admin/notification-rules/preview")) {
        return {
          ok: true,
          data: generateDemoNotificationRulePreview(options.body),
        };
      }
      if (path.includes("/admin/notification-rules/run")) {
        return {
          ok: true,
          data: generateDemoNotificationRuleRun(options.body),
        };
      }
      if (method === "DELETE") {
        return {
          ok: true,
          data: { id: String(params.id || ""), removed: true },
        };
      }
      return {
        ok: true,
        data: createDemoNotificationRule(options.body),
      };
    }
    if (path.includes("/admin/notification-email")) {
      if (method === "DELETE") {
        return {
          ok: true,
          data: redactNotificationEmailConfig(defaultNotificationEmailConfig()),
        };
      }
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const emailBody = body as {
        clearResendApiKey?: unknown;
        enabled?: unknown;
        fromEmail?: unknown;
        fromName?: unknown;
        provider?: unknown;
        replyTo?: unknown;
        resendApiKey?: unknown;
      };
      const configured =
        typeof emailBody.resendApiKey === "string" &&
        emailBody.resendApiKey.trim().length > 0 &&
        emailBody.clearResendApiKey !== true;
      return {
        ok: true,
        data: {
          ...redactNotificationEmailConfig(defaultNotificationEmailConfig()),
          enabled:
            typeof emailBody.enabled === "boolean" ? emailBody.enabled : false,
          provider: emailBody.provider === "none" ? "none" : "resend",
          fromName: String(emailBody.fromName || "InsightFlare"),
          fromEmail: String(emailBody.fromEmail || ""),
          replyTo: String(emailBody.replyTo || ""),
          resend: {
            configured,
            apiKeyHint: configured ? "••••demo" : "",
          },
          updatedAt: Date.now(),
        },
      };
    }
    if (path.includes("/admin/site")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const siteBody = body as {
        siteId?: unknown;
        teamId?: unknown;
        name?: unknown;
        domain?: unknown;
        publicEnabled?: unknown;
        publicSlug?: unknown;
      };
      const existing =
        getDemoSites(String(siteBody.teamId || getDemoTeams()[0].id))[0] ||
        getDemoSites(getDemoTeams()[0].id)[0];
      return {
        ok: true,
        data: {
          ...existing,
          id: String(siteBody.siteId || existing.id),
          name: String(siteBody.name ?? existing.name),
          domain: String(siteBody.domain ?? existing.domain),
          publicEnabled:
            typeof siteBody.publicEnabled === "boolean"
              ? siteBody.publicEnabled
              : existing.publicEnabled,
          publicSlug:
            typeof siteBody.publicSlug === "string"
              ? siteBody.publicSlug
              : existing.publicSlug,
        },
      };
    }
    if (path.includes("/admin/teams")) {
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      if (!teamId) return demoBadRequest("teamId is required");
      const existing =
        getDemoTeams().find((team) => team.id === teamId) ?? getDemoTeams()[0];
      const intent = String(bodyRecord.intent ?? "").toLowerCase();
      if (intent === "remove" || intent === "delete") {
        return {
          ok: true,
          data: {
            teams: getDemoTeams().filter((team) => team.id !== teamId),
          },
        };
      }
      const name = String(bodyRecord.name ?? "").trim();
      if (name.length < 2) return demoBadRequest("Team name is required");
      return { ok: true, data: { ...existing, name } };
    }
    if (path.includes("/admin/members")) {
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      const userId = String(
        params.userId || bodyRecord.userId || bodyRecord.user || "",
      ).trim();
      if (!teamId) return demoBadRequest("teamId is required");
      if (!userId)
        return demoBadRequest("teamId and user identifier are required");
      return { ok: true, data: { teamId, members: getDemoMembers(teamId) } };
    }
    if (path.includes("/admin/users")) {
      const userId = String(
        params.userId || bodyRecord.userId || bodyRecord.id || "",
      ).trim();
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      const user = getDemoUsers()[0];
      return {
        ok: true,
        data: {
          user: { ...user, id: userId || user.id },
          ...(teamId ? { teamId } : {}),
        },
      };
    }
    // Generic write → return empty success
    return { ok: true, data: {} };
  }

  // GET routes
  if (path === "/api/private/session" || path.includes("/admin/auth/me")) {
    return { ok: true, data: { user: getDemoUser(), teams: getDemoTeams() } };
  }
  if (path.includes("/admin/users")) {
    return { ok: true, data: getDemoUsers() };
  }
  if (path.includes("/admin/teams")) {
    return { ok: true, data: getDemoTeams() };
  }
  if (path.includes("/admin/team-invites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: generateDemoTeamInvites(tid) };
  }
  if (path.includes("/admin/sites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoSites(tid) };
  }
  if (path.includes("/admin/members")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoMembers(tid) };
  }
  if (path.includes("/admin/site-config")) {
    return { ok: true, data: getDemoSiteConfig() };
  }
  if (path.includes("/admin/script-snippet")) {
    return { ok: true, data: getDemoScriptSnippet(siteId) };
  }
  if (path.includes("/admin/api-keys")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: generateDemoApiKeys(tid) };
  }
  if (path.includes("/admin/bot-analytics-config")) {
    const config = defaultBotAnalyticsConfig();
    return { ok: true, data: redactBotAnalyticsConfig(config) };
  }
  if (path.includes("/admin/bot-analytics")) {
    return demoBotAnalyticsResponse(params);
  }
  if (path.includes("/admin/notification-rules")) {
    return {
      ok: true,
      data: generateDemoNotificationRules(teamId || getDemoTeams()[0].id),
    };
  }
  if (path === "/api/private/notifications") {
    const messages = generateDemoNotificationMessages(
      teamId || getDemoTeams()[0].id,
      locale,
    );
    return {
      ok: true,
      data: {
        messages,
        unreadAttentionCount: messages.filter(
          (message) => message.requiresAttention && message.readAt === null,
        ).length,
      },
    };
  }
  if (path === "/api/private/notifications/preferences") {
    return { ok: true, data: demoNotificationPreferences };
  }
  if (path.includes("/admin/notification-email")) {
    return {
      ok: true,
      data: redactNotificationEmailConfig(defaultNotificationEmailConfig()),
    };
  }
  if (path.includes("/admin/login-turnstile")) {
    return { ok: true, data: demoLoginTurnstileConfig() };
  }
  if (path === "/api/public/login-security") {
    return {
      ok: true,
      data: {
        turnstile: {
          enabled: false,
          siteKey: "",
          mode: "invisible",
        },
      },
    };
  }
  if (path.includes("/admin/scheduled-tasks")) {
    return generateDemoScheduledTasks(params);
  }
  if (path.includes("/admin/system-performance")) {
    return generateDemoSystemPerformance(params);
  }
  if (path.includes("/admin/do-diagnostic")) {
    return generateDemoDoDiagnostic();
  }

  const publicSiteMatch = path.match(/\/api\/public\/share\/([^/]+)\/site$/);
  if (publicSiteMatch) {
    const slug = decodeURIComponent(publicSiteMatch[1] || "demo-site");
    const profile = publicSiteProfile ?? findSiteProfileByPublicSlug(slug);
    if (!profile) return demoNotFoundResponse();
    return {
      ok: true,
      data: {
        id: profile.id,
        slug,
        name: profile.name,
        domain: profile.domain,
      },
    };
  }

  // Analytics query routes
  if (path.includes("/filter-values")) {
    return generateDemoFilterValues(
      siteId,
      params,
      path.includes("/api/public/")
        ? "public-share"
        : path.includes("/api/v1/")
          ? "api-v1"
          : "private-dashboard",
    );
  }
  if (path.includes("/overview-page-path")) {
    return generateDemoOverviewPageTab(siteId, params, "path");
  }
  if (path.includes("/overview-page-title")) {
    return generateDemoOverviewPageTab(siteId, params, "title");
  }
  if (path.includes("/overview-page-hostname")) {
    return generateDemoOverviewPageTab(siteId, params, "hostname");
  }
  if (path.includes("/overview-page-entry")) {
    return generateDemoOverviewPageTab(siteId, params, "entry");
  }
  if (path.includes("/overview-page-exit")) {
    return generateDemoOverviewPageTab(siteId, params, "exit");
  }
  if (path.includes("/overview-source-channel")) {
    return generateDemoOverviewSourceTab(siteId, params, "channel");
  }
  if (path.includes("/overview-source-domain")) {
    return generateDemoOverviewSourceTab(siteId, params, "domain");
  }
  if (path.includes("/overview-source-link")) {
    return generateDemoOverviewSourceTab(siteId, params, "link");
  }
  if (path.includes("/overview-client-browser")) {
    return generateDemoOverviewClientTab(siteId, params, "browser");
  }
  if (path.includes("/overview-client-os-version")) {
    return generateDemoOverviewClientTab(siteId, params, "osVersion");
  }
  if (path.includes("/overview-client-device-type")) {
    return generateDemoOverviewClientTab(siteId, params, "deviceType");
  }
  if (path.includes("/overview-client-language")) {
    return generateDemoOverviewClientTab(siteId, params, "language");
  }
  if (path.includes("/overview-client-screen-size")) {
    return generateDemoOverviewClientTab(siteId, params, "screenSize");
  }
  if (path.includes("/overview-geo-country")) {
    return generateDemoOverviewGeoTab(siteId, params, "country");
  }
  if (path.includes("/overview-geo-region")) {
    return generateDemoOverviewGeoTab(siteId, params, "region");
  }
  if (path.includes("/overview-geo-city")) {
    return generateDemoOverviewGeoTab(siteId, params, "city");
  }
  if (path.includes("/overview-geo-continent")) {
    return generateDemoOverviewGeoTab(siteId, params, "continent");
  }
  if (path.includes("/overview-geo-timezone")) {
    return generateDemoOverviewGeoTab(siteId, params, "timezone");
  }
  if (path.includes("/overview-geo-organization")) {
    return generateDemoOverviewGeoTab(siteId, params, "organization");
  }
  if (path.includes("/overview-geo-points")) {
    return generateDemoGeoPoints(siteId, params);
  }
  if (path.includes("/event-record-detail")) {
    return generateDemoEventRecordDetail(siteId, params);
  }
  if (
    (path.includes("/api/private/") || path.includes("/api/v1/")) &&
    (path.includes("/event-type-field-values") ||
      path.includes("/event-fields/values"))
  ) {
    return generateDemoEventTypeFieldValues(siteId, params);
  }
  if (
    (path.includes("/api/private/") || path.includes("/api/v1/")) &&
    (path.includes("/event-type-fields") || path.endsWith("/event-fields"))
  ) {
    return generateDemoEventFields(siteId, params);
  }
  if (path.includes("/event-type-detail")) {
    return generateDemoEventTypeDetail(siteId, params);
  }
  if (path.includes("/events-summary")) {
    return generateDemoEventsSummary(siteId, params);
  }
  if (path.includes("/events-trend")) {
    return generateDemoEventsTrend(siteId, params);
  }
  if (path.includes("/events-records")) {
    return generateDemoEventsRecords(siteId, params);
  }
  if (path.includes("/team-dashboard")) {
    const tid = teamId || getDemoTeams()[0].id;
    return generateDemoTeamDashboard(tid, params);
  }
  if (path.includes("/pages-dashboard")) {
    return generateDemoPagesDashboard(siteId, params);
  }
  if (path.includes("/funnels")) {
    return generateDemoFunnels(siteId, params);
  }
  if (path.includes("/retention")) {
    return generateDemoRetention(siteId, params);
  }
  if (path.includes("/performance")) {
    return generateDemoPerformance(siteId, params);
  }
  if (path.includes("/overview")) {
    return generateDemoOverview(siteId, params);
  }
  if (path.includes("/browser-cross-breakdown")) {
    return generateDemoBrowserCrossBreakdown(siteId, params);
  }
  if (path.includes("/browser-version-breakdown")) {
    return generateDemoBrowserVersionBreakdown(siteId, params);
  }
  if (path.includes("/browser-radar")) {
    return generateDemoBrowserRadar(siteId, params);
  }
  if (path.includes("/referrer-radar")) {
    return generateDemoReferrerRadar(siteId, params);
  }
  if (path.includes("/referrer-dimension-trend")) {
    return generateDemoReferrerTrend(siteId, params);
  }
  if (path.includes("/browser-trend")) {
    return generateDemoBrowserTrend(siteId, params);
  }
  if (path.includes("/browser-engine-trend")) {
    return generateDemoBrowserEngineTrend(siteId, params);
  }
  if (path.includes("/client-dimension-trend")) {
    return generateDemoClientDimensionTrend(siteId, params);
  }
  if (path.includes("/utm-dimension-trend")) {
    return generateDemoUtmTrend(siteId, params);
  }
  if (path.includes("/client-cross-breakdown")) {
    return generateDemoClientCrossBreakdown(siteId, params);
  }
  if (path.includes("/trend")) {
    return generateDemoTrend(siteId, params);
  }
  if (path.includes("/session-detail")) {
    return generateDemoSessionDetail(siteId, params);
  }
  if (path.includes("/visitor-detail")) {
    return generateDemoVisitorDetail(siteId, params);
  }
  if (path.includes("/sessions")) {
    return generateDemoSessions(siteId, params);
  }
  if (path.includes("/pages")) {
    return generateDemoPages(siteId, params);
  }
  if (path.includes("/referrers")) {
    return generateDemoReferrers(siteId, params);
  }
  if (path.includes("/utm-source")) {
    return generateDemoUtmDimension(siteId, "source", params);
  }
  if (path.includes("/utm-medium")) {
    return generateDemoUtmDimension(siteId, "medium", params);
  }
  if (path.includes("/utm-campaign")) {
    return generateDemoUtmDimension(siteId, "campaign", params);
  }
  if (path.includes("/utm-term")) {
    return generateDemoUtmDimension(siteId, "term", params);
  }
  if (path.includes("/utm-content")) {
    return generateDemoUtmDimension(siteId, "content", params);
  }
  if (path.includes("/visitors")) {
    return generateDemoVisitors(siteId, params);
  }
  if (path.includes("/countries")) {
    return generateDemoDimension(siteId, "countries", params);
  }
  if (path.includes("/devices")) {
    return generateDemoDimension(siteId, "devices", params);
  }
  if (path.includes("/page-hash")) {
    return generateDemoDimension(siteId, "page-hash", params);
  }
  if (path.includes("/page-query")) {
    return generateDemoDimension(siteId, "page-query", params);
  }
  if (path.includes("/event-types")) {
    return generateDemoDimension(siteId, "event-types", params);
  }

  // Public routes — delegate to same generators
  const publicMatch = path.match(/\/api\/public\/share\/[^/]+\/(.*)/);
  if (publicMatch) {
    if (!publicSiteProfile) return demoNotFoundResponse();
    const subPath = publicMatch[1];
    if (subPath === "overview") return generateDemoOverview(siteId, params);
    if (subPath === "trend") return generateDemoTrend(siteId, params);
    if (subPath === "pages") return generateDemoPages(siteId, params);
    if (subPath === "referrers") return generateDemoReferrers(siteId, params);
    if (subPath === "performance")
      return generateDemoPerformance(siteId, params);
    if (subPath === "countries")
      return generateDemoDimension(siteId, "countries", params);
    if (subPath === "filter-values")
      return generateDemoFilterValues(siteId, params, "public-share");
    if (subPath === "overview-geo-points")
      return generateDemoGeoPoints(siteId, params);
    if (subPath.startsWith("overview-client-")) {
      if (subPath === "overview-client-browser") {
        return generateDemoOverviewClientTab(siteId, params, "browser");
      }
      if (subPath === "overview-client-os-version") {
        return generateDemoOverviewClientTab(siteId, params, "osVersion");
      }
      if (subPath === "overview-client-device-type") {
        return generateDemoOverviewClientTab(siteId, params, "deviceType");
      }
      if (subPath === "overview-client-language") {
        return generateDemoOverviewClientTab(siteId, params, "language");
      }
      if (subPath === "overview-client-screen-size") {
        return generateDemoOverviewClientTab(siteId, params, "screenSize");
      }
    }
    if (subPath.startsWith("overview-geo-")) {
      const tab = subPath.replace("overview-geo-", "");
      if (
        tab === "country" ||
        tab === "region" ||
        tab === "city" ||
        tab === "continent" ||
        tab === "timezone" ||
        tab === "organization"
      ) {
        return generateDemoOverviewGeoTab(siteId, params, tab);
      }
    }
    if (subPath === "browser-trend")
      return generateDemoBrowserTrend(siteId, params);
    if (subPath === "browser-engine-trend")
      return generateDemoBrowserEngineTrend(siteId, params);
    if (subPath === "browser-version-breakdown")
      return generateDemoBrowserVersionBreakdown(siteId, params);
    if (subPath === "browser-cross-breakdown")
      return generateDemoBrowserCrossBreakdown(siteId, params);
    if (subPath === "browser-radar")
      return generateDemoBrowserRadar(siteId, params);
    if (subPath === "referrer-radar")
      return generateDemoReferrerRadar(siteId, params);
    if (subPath === "referrer-dimension-trend")
      return generateDemoReferrerTrend(siteId, params);
    if (subPath === "client-dimension-trend")
      return generateDemoClientDimensionTrend(siteId, params);
    if (subPath === "client-cross-breakdown")
      return generateDemoClientCrossBreakdown(siteId, params);
    return demoNotFoundResponse();
  }

  // Fallback
  return demoNotFoundResponse();
}

function demoBotAnalyticsResponse(
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = Number(params.from);
  const to = Number(params.to);
  const requestedMinutes =
    Number.isFinite(from) && Number.isFinite(to) && to > from
      ? Math.ceil((to - from) / 60_000)
      : 60;
  const minutes =
    requestedMinutes <= 60
      ? 60
      : requestedMinutes <= 1440
        ? 1440
        : requestedMinutes <= 10080
          ? 10080
          : 43200;
  const data = generateDemoRequestObservationData(
    minutes,
    Number.isFinite(to) && to > 0 ? to : undefined,
  ) as unknown as {
    ok: true;
    configured: boolean;
    generatedAt: number;
    events: Array<Record<string, unknown>>;
    normal?: { events?: Array<Record<string, unknown>> };
  } & Record<string, unknown>;

  if (params.detail === "1") {
    const traceId = String(params.traceId || "");
    const rayId = String(params.rayId || "");
    const detail = data.events.find(
      (event) => event.traceId === traceId || event.rayId === rayId,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      detail: detail ?? null,
    };
  }

  const source = params.page === "normal" ? "normal" : "abnormal";
  const events =
    source === "normal" ? (data.normal?.events ?? []) : data.events;
  if (params.page === "normal" || params.page === "abnormal") {
    const page = paginateDemoBotEvents(
      events,
      parseDemoBotAnalyticsLimit(params.limit),
      params.cursor,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      page: {
        source,
        ...page,
      },
    };
  }

  if (params.dimensionTab) {
    const key = String(params.dimensionTab);
    const counts = new Map<string, { count: number; highConfidence: number }>();
    for (const event of events) {
      const value = String(event[key] ?? "Unknown");
      const current = counts.get(value) ?? { count: 0, highConfidence: 0 };
      current.count += 1;
      if (event.confidence === "high") current.highConfidence += 1;
      counts.set(value, current);
    }
    return {
      ok: true,
      dimension: {
        rows: [...counts.entries()]
          .map(([key, value]) => ({ key, label: key, ...value }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 30),
      },
    };
  }

  const abnormalPage = paginateDemoBotEvents(
    data.events,
    parseDemoBotAnalyticsLimit(params.limit),
  );
  const normalPage = paginateDemoBotEvents(
    data.normal?.events ?? [],
    parseDemoBotAnalyticsLimit(params.limit),
  );

  return {
    ...data,
    events: abnormalPage.events,
    normalEvents: normalPage.events,
    abnormal: data.abnormal
      ? {
          ...data.abnormal,
          events: abnormalPage.events,
          hasMore: abnormalPage.hasMore,
          nextCursor: abnormalPage.nextCursor,
        }
      : data.abnormal,
    normal: data.normal
      ? {
          ...data.normal,
          events: normalPage.events,
          hasMore: normalPage.hasMore,
          nextCursor: normalPage.nextCursor,
        }
      : data.normal,
  };
}

const DEMO_BOT_ANALYTICS_DEFAULT_LIMIT = 50;

function parseDemoBotAnalyticsLimit(value: unknown): number {
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(
      100,
      Number.isFinite(parsed)
        ? Math.trunc(parsed)
        : DEMO_BOT_ANALYTICS_DEFAULT_LIMIT,
    ),
  );
}

function parseDemoBotAnalyticsCursor(
  value: unknown,
): { timestamp: string; receivedAt: number } | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as {
      timestamp?: unknown;
      receivedAt?: unknown;
    };
    const timestamp = String(parsed.timestamp || "");
    const receivedAt = Number(parsed.receivedAt);
    if (!timestamp || !Number.isFinite(receivedAt)) return null;
    return { timestamp, receivedAt };
  } catch {
    return null;
  }
}

function paginateDemoBotEvents(
  events: Array<Record<string, unknown>>,
  limit: number,
  cursorValue?: unknown,
): {
  events: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: { timestamp: string; receivedAt: number } | null;
} {
  const cursor = parseDemoBotAnalyticsCursor(cursorValue);
  const startIndex = cursor
    ? Math.max(
        0,
        events.findIndex(
          (event) =>
            String(event.timestamp || "") === cursor.timestamp &&
            Number(event.receivedAt) === cursor.receivedAt,
        ) + 1,
      )
    : 0;
  const pageEvents = events.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + pageEvents.length < events.length;
  const lastEvent = pageEvents[pageEvents.length - 1];
  const nextCursor =
    hasMore && lastEvent
      ? {
          timestamp: String(lastEvent.timestamp || ""),
          receivedAt: Number(lastEvent.receivedAt),
        }
      : null;

  return { events: pageEvents, hasMore, nextCursor };
}

/**
 * Standalone entry point. Runs the dispatcher, then normalizes any success
 * envelope to the standard `{ ok:true, requestId, timestamp, ... }` shape so
 * demo responses are compatible with the real private/public API. Failures are
 * already emitted in the standard `{ ok:false, error:{ code, message } }` shape
 * by the dispatcher and pass through untouched.
 */
export function handleDemoRequest(
  options: Parameters<typeof handleDemoRequestInner>[0],
): unknown {
  const result: unknown = handleDemoRequestInner(options);
  if (
    result &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === true &&
    typeof (result as { requestId?: unknown }).requestId !== "string"
  ) {
    return demoOk({ ...(result as Record<string, unknown>) });
  }
  return result;
}

/**
 * Demo request entry point with failure detection. Mirrors the real fetch
 * branches: a standard failure envelope throws an Error whose message is the
 * server-style error message, so demo consumers land in the same catch path.
 */
export function demoRequest(
  options: Parameters<typeof handleDemoRequest>[0],
): unknown {
  const result = handleDemoRequest(options);
  if (isErrorEnvelope(result)) {
    throw new Error(extractErrorMessage(result));
  }
  return result;
}
