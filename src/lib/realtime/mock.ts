import {
  defaultAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
} from "@/lib/analytics-engine-config";
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
  updateDemoScheduledTasks,
} from "@/lib/realtime/mock/admin";
import {
  generateDemoDimension,
  generateDemoOverview,
  generateDemoPages,
  generateDemoPagesDashboard,
  generateDemoPerformance,
  generateDemoReferrers,
  generateDemoReferrerSummary,
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
  generateDemoEventTypeContext,
  generateDemoEventTypeDetail,
  generateDemoEventTypeFieldValues,
} from "@/lib/realtime/mock/events";
import { parseDemoInterval } from "@/lib/realtime/mock/filters";
import {
  createDemoFunnel,
  deleteDemoFunnel,
  generateDemoFunnels,
  updateDemoFunnel,
} from "@/lib/realtime/mock/funnels";
import {
  generateDemoJourneyEventDetail,
  generateDemoSessionDetail,
  generateDemoSessions,
  generateDemoVisitorDetail,
  generateDemoVisitors,
} from "@/lib/realtime/mock/journeys";
import {
  DemoInvalidCursorError,
  demoPage,
  type DemoPagination,
} from "@/lib/realtime/mock/pagination";
import { generateDemoRequestObservationData } from "@/lib/realtime/mock/request-observation";
import { handleDemoSavedFilters } from "@/lib/realtime/mock/saved-filters";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoChannelTrend,
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

function paginateDemoEnvelope(
  result: unknown,
  params: Record<string, string | number>,
  fallbackLimit: number,
  operation = "demo-collection",
  maxLimit = 200,
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.data)) return result;
  const page = demoPage(
    record.data,
    params,
    {
      operation,
      siteId: params.siteId ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
      search: String(params.search ?? "")
        .trim()
        .toLowerCase(),
      filterKey: params.filterKey ?? null,
      tab: params.tab ?? null,
      dimension: params.dimension ?? null,
    },
    fallbackLimit,
    maxLimit,
  );
  return {
    ...record,
    data: page,
  };
}

function demoShareTrendDimension(result: unknown): {
  series: unknown[];
  data: unknown[];
} {
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    series: Array.isArray(record.series) ? record.series : [],
    data: Array.isArray(record.data) ? record.data : [],
  };
}

const DEMO_CLIENT_DIMENSIONS = new Set([
  "browser",
  "operatingSystem",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
]);
const DEMO_UTM_DIMENSIONS = new Set([
  "source",
  "medium",
  "campaign",
  "term",
  "content",
]);
const DEMO_CROSS_DIMENSIONS = new Set([
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "referrer.domain",
  "referrer.url",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "operatingSystem",
  "client.osVersion",
  "osVersion",
  "client.deviceType",
  "deviceType",
  "client.language",
  "language",
  "client.screenSize",
  "screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
]);
const DEMO_EVENT_CONTEXT_CARDS = new Set([
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
  "sourceDomain",
  "sourceLink",
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
]);

function parseDemoRequestNumber(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function invalidDemoTimeWindow(
  params: Record<string, string | number>,
): boolean {
  const hasFrom = Object.prototype.hasOwnProperty.call(params, "from");
  const hasTo = Object.prototype.hasOwnProperty.call(params, "to");
  const from = hasFrom ? parseDemoRequestNumber(params.from!) : null;
  const to = hasTo ? parseDemoRequestNumber(params.to!) : null;
  if ((hasFrom && from === null) || (hasTo && to === null)) return true;

  const now = Date.now();
  const start = from ?? now - 24 * 60 * 60 * 1000;
  const end = to ?? now;
  return start < 0 || end <= start;
}

function demoRequiredParam(
  params: Record<string, string | number>,
  key: string,
): boolean {
  return String(params[key] ?? "").trim().length > 0;
}

function validateDemoAnalyticsRequest(
  path: string,
  params: Record<string, string | number>,
): unknown | null {
  const isAnalyticsRequest =
    path.includes("/api/private/") ||
    path.includes("/api/public/share/") ||
    path.includes("/api/v1/");
  if (!isAnalyticsRequest) return null;
  if (invalidDemoTimeWindow(params))
    return demoBadRequest("Invalid time window");

  if (path.includes("/client-dimension-trend")) {
    const dimension = String(params.dimension ?? "").trim();
    if (!DEMO_CLIENT_DIMENSIONS.has(dimension)) {
      return demoBadRequest("Invalid client dimension");
    }
  }
  if (path.includes("/utm-dimension-trend")) {
    const dimension = String(params.dimension ?? "").trim();
    if (!DEMO_UTM_DIMENSIONS.has(dimension)) {
      return demoBadRequest("Invalid UTM dimension");
    }
  }
  if (path.includes("/client-cross-breakdown")) {
    const primary = String(params.primaryDimension ?? "").trim();
    const secondary = String(params.secondaryDimension ?? "").trim();
    if (!DEMO_CROSS_DIMENSIONS.has(primary)) {
      return demoBadRequest("Unsupported primary dimension");
    }
    if (!DEMO_CROSS_DIMENSIONS.has(secondary)) {
      return demoBadRequest("Unsupported secondary dimension");
    }
    if (primary === secondary) {
      return demoBadRequest("Primary and secondary dimensions must differ");
    }
  }
  if (path.includes("/event-type-context")) {
    if (!demoRequiredParam(params, "eventName")) {
      return demoBadRequest("eventName is required");
    }
    const cards = [
      ...new Set(
        String(params.cards ?? "")
          .split(",")
          .map((card) => card.trim())
          .filter(Boolean),
      ),
    ];
    if (
      cards.length === 0 ||
      cards.length > DEMO_EVENT_CONTEXT_CARDS.size ||
      cards.some((card) => !DEMO_EVENT_CONTEXT_CARDS.has(card))
    ) {
      return demoBadRequest("Valid context cards are required");
    }
  }
  if (
    path.includes("/event-type-detail") &&
    !demoRequiredParam(params, "eventName")
  ) {
    return demoBadRequest("eventName is required");
  }
  if (
    path.includes("/event-type-field-values") ||
    path.includes("/event-fields/values")
  ) {
    if (String(params.fieldPath ?? "").length === 0) {
      return demoBadRequest("fieldPath is required");
    }
    if (!demoRequiredParam(params, "fieldValueType")) {
      return demoBadRequest("fieldValueType is required");
    }
    const fieldValueType = String(params.fieldValueType).trim();
    if (
      !new Set(["string", "number", "boolean", "object", "array", "null"]).has(
        fieldValueType,
      )
    ) {
      return demoBadRequest("Invalid fieldValueType");
    }
  }
  if (
    path.includes("/event-record-detail") &&
    !demoRequiredParam(params, "eventId")
  ) {
    return demoBadRequest("eventId is required");
  }
  if (
    (path.includes("/journey-event-detail") ||
      path.includes("/journey-events/detail")) &&
    !demoRequiredParam(params, "eventId")
  ) {
    return demoBadRequest("Missing eventId");
  }
  if (
    (path.includes("/journey-event-detail") ||
      path.includes("/journey-events/detail")) &&
    params.eventKind !== undefined &&
    !new Set(["pageview", "session_start", "leave"]).has(
      String(params.eventKind).trim(),
    )
  ) {
    return demoBadRequest("Invalid eventKind");
  }
  if (
    path.includes("/visitor-detail") &&
    !demoRequiredParam(params, "visitorId")
  ) {
    return demoBadRequest("Missing visitorId");
  }
  if (
    path.includes("/session-detail") &&
    !demoRequiredParam(params, "sessionId")
  ) {
    return demoBadRequest("Missing sessionId");
  }
  if (path.includes("/visitor-events") || path.includes("/visitor-sessions")) {
    if (!demoRequiredParam(params, "visitorId")) {
      return demoBadRequest("Missing visitorId");
    }
  }
  if (
    path.includes("/session-events") &&
    !demoRequiredParam(params, "sessionId")
  ) {
    return demoBadRequest("Missing sessionId");
  }
  return null;
}

function paginateDemoDetailCollection(
  result: unknown,
  collectionKey: "events" | "sessions",
  params: Record<string, string | number>,
): { ok: boolean; data: { items: unknown[]; pagination: DemoPagination } } {
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const detail =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : {};
  const rows = Array.isArray(detail[collectionKey])
    ? detail[collectionKey]
    : [];
  const collectionId =
    collectionKey === "events"
      ? String(params.visitorId ?? params.sessionId ?? "")
      : String(params.visitorId ?? "");
  const page = demoPage(
    rows,
    params,
    {
      operation:
        collectionKey === "events" ? "detail-events" : "detail-sessions",
      siteId: String(params.siteId ?? ""),
      collectionKey,
      collectionId,
      from: params.from ?? null,
      to: params.to ?? null,
    },
    100,
  );
  return { ok: record.ok !== false, data: page };
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
    return handleDemoSavedFilters({
      path,
      method,
      siteId,
      params,
      body: options.body,
    });
  }

  // Write operations → read-only stub
  if (
    method === "POST" ||
    method === "PATCH" ||
    method === "PUT" ||
    method === "DELETE"
  ) {
    if (path.includes("/admin/scheduled-tasks")) {
      const retentionPatch =
        bodyRecord.retention &&
        typeof bodyRecord.retention === "object" &&
        !Array.isArray(bodyRecord.retention)
          ? (bodyRecord.retention as Record<string, unknown>)
          : {};
      if (bodyRecord.retentionDays !== undefined) {
        retentionPatch.scheduledTaskLogsDays = bodyRecord.retentionDays;
      }
      updateDemoScheduledTasks({
        taskKey: bodyRecord.taskKey,
        enabled: bodyRecord.enabled,
        retention:
          Object.keys(retentionPatch).length > 0 ? retentionPatch : undefined,
        retentionDays: bodyRecord.retentionDays,
      });
      return { ok: true, data: generateDemoScheduledTasks(params) };
    }
    if (path.includes("/admin/analytics-engine-config")) {
      const body = bodyRecord as {
        accountId?: unknown;
        apiToken?: unknown;
        clearApiToken?: unknown;
      };
      const config = defaultAnalyticsEngineConfig();
      config.accountId = String(body.accountId ?? "").trim();
      config.configured =
        body.clearApiToken !== true &&
        String(body.apiToken ?? "").trim() !== "";
      config.apiTokenHint = config.configured ? "••••demo" : "";
      config.updatedAt = Date.now();
      return { ok: true, data: redactAnalyticsEngineConfig(config) };
    }
    if (path.includes("/funnels")) {
      if (method === "DELETE") return deleteDemoFunnel(siteId, params);
      if (method === "PATCH")
        return updateDemoFunnel(siteId, params, options.body);
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
  if (path.includes("/admin/analytics-engine-config")) {
    const config = defaultAnalyticsEngineConfig();
    return { ok: true, data: redactAnalyticsEngineConfig(config) };
  }
  if (path.includes("/admin/request-observation")) {
    return demoRequestObservationResponse(params);
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
  const analyticsValidationError = validateDemoAnalyticsRequest(path, params);
  if (analyticsValidationError) return analyticsValidationError;
  if (path.includes("/filter-values")) {
    return paginateDemoEnvelope(
      generateDemoFilterValues(
        siteId,
        params,
        path.includes("/api/public/")
          ? "public-share"
          : path.includes("/api/v1/")
            ? "api-v1"
            : "private-dashboard",
      ),
      params,
      50,
      path.includes("/api/public/")
        ? "filter-values:public"
        : path.includes("/api/v1/")
          ? "filter-values:api-v1"
          : "filter-values:private",
      500,
    );
  }
  if (path.includes("/overview-page-path")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "path"),
      params,
      100,
      "overview-page-path",
    );
  }
  if (path.includes("/overview-page-title")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "title"),
      params,
      100,
      "overview-page-title",
    );
  }
  if (path.includes("/overview-page-hostname")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "hostname"),
      params,
      100,
      "overview-page-hostname",
    );
  }
  if (path.includes("/overview-page-entry")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "entry"),
      params,
      100,
      "overview-page-entry",
    );
  }
  if (path.includes("/overview-page-exit")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "exit"),
      params,
      100,
      "overview-page-exit",
    );
  }
  if (path.includes("/overview-source-channel")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "channel"),
      params,
      100,
      "overview-source-channel",
    );
  }
  if (path.includes("/overview-source-domain")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "domain"),
      params,
      100,
      "overview-source-domain",
    );
  }
  if (path.includes("/overview-source-link")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "link"),
      params,
      100,
      "overview-source-link",
    );
  }
  if (path.includes("/referrer-summary")) {
    return generateDemoReferrerSummary(siteId, params);
  }
  if (path.includes("/overview-client-browser")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "browser"),
      params,
      100,
      "overview-client-browser",
    );
  }
  if (path.includes("/overview-client-os-version")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "osVersion"),
      params,
      100,
      "overview-client-os-version",
    );
  }
  if (path.includes("/overview-client-device-type")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "deviceType"),
      params,
      100,
      "overview-client-device-type",
    );
  }
  if (path.includes("/overview-client-language")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "language"),
      params,
      100,
      "overview-client-language",
    );
  }
  if (path.includes("/overview-client-screen-size")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "screenSize"),
      params,
      100,
      "overview-client-screen-size",
    );
  }
  if (path.includes("/overview-geo-country")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "country"),
      params,
      100,
      "overview-geo-country",
    );
  }
  if (path.includes("/overview-geo-region")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "region"),
      params,
      100,
      "overview-geo-region",
    );
  }
  if (path.includes("/overview-geo-city")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "city"),
      params,
      100,
      "overview-geo-city",
    );
  }
  if (path.includes("/overview-geo-continent")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "continent"),
      params,
      100,
      "overview-geo-continent",
    );
  }
  if (path.includes("/overview-geo-timezone")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "timezone"),
      params,
      100,
      "overview-geo-timezone",
    );
  }
  if (path.includes("/overview-geo-organization")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "organization"),
      params,
      100,
      "overview-geo-organization",
    );
  }
  if (path.includes("/overview-geo-points")) {
    return generateDemoGeoPoints(siteId, params);
  }
  if (
    path.includes("/journey-event-detail") ||
    path.includes("/journey-events/detail")
  ) {
    return generateDemoJourneyEventDetail(siteId, params);
  }
  if (path.includes("/visitor-events")) {
    return paginateDemoDetailCollection(
      generateDemoVisitorDetail(siteId, params),
      "events",
      params,
    );
  }
  if (path.includes("/visitor-sessions")) {
    return paginateDemoDetailCollection(
      generateDemoVisitorDetail(siteId, params),
      "sessions",
      params,
    );
  }
  if (path.includes("/session-events")) {
    return paginateDemoDetailCollection(
      generateDemoSessionDetail(siteId, params),
      "events",
      params,
    );
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
  if (path.includes("/event-type-context")) {
    return generateDemoEventTypeContext(siteId, params);
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
  if (path.includes("/referrer-channel-dimension-trend")) {
    return {
      ok: true,
      interval: parseDemoInterval(params.interval),
      source: demoShareTrendDimension(
        generateDemoReferrerTrend(siteId, params, { maxLimit: 12 }),
      ),
      channel: demoShareTrendDimension(
        generateDemoChannelTrend(siteId, params, { maxLimit: 12 }),
      ),
    };
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
    return generateDemoPages(siteId, params, {
      includeTabs: !path.includes("/api/public/") && !path.includes("/api/v1/"),
      defaultLimit: 20,
    });
  }
  if (path.includes("/referrers")) {
    const isPublic = path.includes("/api/public/");
    return generateDemoReferrers(siteId, params, {
      allowFullUrl: !isPublic,
      defaultLimit: isPublic ? 8 : 20,
    });
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
    return demoNotFoundResponse();
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
    if (subPath === "pages")
      return generateDemoPages(siteId, params, {
        includeTabs: false,
        defaultLimit: 20,
      });
    if (subPath === "referrers")
      return generateDemoReferrers(siteId, params, {
        allowFullUrl: false,
        defaultLimit: 8,
      });
    if (subPath === "referrer-summary")
      return generateDemoReferrerSummary(siteId, params);
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
        return paginateDemoEnvelope(
          generateDemoOverviewGeoTab(siteId, params, tab),
          params,
          100,
          `overview-geo-${tab}`,
        );
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
    if (subPath === "referrer-channel-dimension-trend")
      return {
        ok: true,
        interval: parseDemoInterval(params.interval),
        source: demoShareTrendDimension(
          generateDemoReferrerTrend(siteId, params, { maxLimit: 12 }),
        ),
        channel: demoShareTrendDimension(
          generateDemoChannelTrend(siteId, params, { maxLimit: 12 }),
        ),
      };
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

function demoRequestObservationResponse(
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
  );
  const serializeDetailEvent = (event: Record<string, unknown>) => {
    const { sampleWeight: _sampleWeight, ...serialized } = event;
    return serialized;
  };
  const serializeListEvent = (
    event: Record<string, unknown>,
    source: "blocked" | "included",
  ) => {
    const shared = {
      timestamp: event.timestamp,
      receivedAt: event.receivedAt,
      siteId: event.siteId,
      siteName: event.siteName,
      siteDomain: event.siteDomain,
      kind: event.kind,
      category: event.category,
      disposition: event.disposition,
      pathname: event.pathname,
      country: event.country,
      region: event.region,
      asOrganization: event.asOrganization,
      asn: event.asn,
      rayId: event.rayId,
      traceId: event.traceId,
    };
    if (source === "blocked") {
      return {
        ...shared,
        reasons: event.reasons,
        ip: event.ip,
        userAgent: event.userAgent,
        verifiedBotCategory: event.verifiedBotCategory,
        botScore: event.botScore,
      };
    }
    return {
      ...shared,
      hostname: event.hostname,
      colo: event.colo,
      requestMethod: event.requestMethod,
      edgeLatencyMs: event.edgeLatencyMs,
    };
  };
  const blockedEvents = data.blockedEvents as unknown as Array<
    Record<string, unknown>
  >;
  const includedEvents = data.includedEvents as unknown as Array<
    Record<string, unknown>
  >;

  if (params.detail === "1") {
    const traceId = String(params.traceId || "");
    const rayId = String(params.rayId || "");
    const detail = [...blockedEvents, ...includedEvents].find(
      (event) => event.traceId === traceId || event.rayId === rayId,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      sampling: data.sampling,
      detail: detail ? serializeDetailEvent(detail) : null,
    };
  }

  const rawPage = String(params.source || "");
  const source =
    rawPage === "abnormal"
      ? "blocked"
      : rawPage === "normal"
        ? "included"
        : rawPage;
  const events = source === "included" ? includedEvents : blockedEvents;
  if (source === "blocked" || source === "included") {
    const page = demoPage(
      events,
      params,
      {
        operation: "request-observation-events",
        source,
        from,
        to,
        interval: minutes,
        order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
      },
      parseRequestObservationLimit(params.limit),
      100,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      sampling: data.sampling,
      source,
      data: {
        items: page.items.map((event) => serializeListEvent(event, source)),
        pagination: page.pagination,
      },
    };
  }

  if (params.dimensionTab) {
    const group = String(params.dimensionGroup || "");
    const tab = String(params.dimensionTab);
    const rawDimensionSource = String(params.dimensionSource || "blocked");
    const dimensionSource =
      rawDimensionSource === "abnormal"
        ? "blocked"
        : rawDimensionSource === "normal"
          ? "included"
          : rawDimensionSource === "included"
            ? "included"
            : "blocked";
    const dimensionEvents =
      dimensionSource === "included" ? includedEvents : blockedEvents;
    const counts = new Map<
      string,
      DemoRequestObservationDimensionValue & {
        count: number;
        botCount: number;
      }
    >();
    for (const event of dimensionEvents) {
      for (const value of demoRequestObservationDimensionValues(
        event,
        group,
        tab,
      )) {
        const current = counts.get(value.key) ?? {
          ...value,
          count: 0,
          botCount: 0,
        };
        const sampleWeight = Math.max(1, Number(event.sampleWeight) || 1);
        current.count += sampleWeight;
        if (event.category === "bot") current.botCount += sampleWeight;
        counts.set(value.key, current);
      }
    }
    return {
      ok: true,
      sampling: data.sampling,
      dimension: {
        group,
        tab,
        source: dimensionSource,
        rows: [...counts.entries()]
          .map(([key, value]) => ({
            key,
            label: value.label,
            count: value.count,
            botCount: value.botCount,
            ...(value.iconLabel ? { iconLabel: value.iconLabel } : {}),
            ...(value.country ? { country: value.country } : {}),
            ...(value.region ? { region: value.region } : {}),
          }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 30),
      },
    };
  }

  const blockedPage = demoPage(
    blockedEvents,
    params,
    {
      operation: "request-observation-events",
      source: "blocked",
      from,
      to,
      interval: minutes,
      order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
    },
    parseRequestObservationLimit(params.limit),
    100,
  );
  const includedPage = demoPage(
    includedEvents,
    params,
    {
      operation: "request-observation-events",
      source: "included",
      from,
      to,
      interval: minutes,
      order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
    },
    parseRequestObservationLimit(params.limit),
    100,
  );
  const serializedBlockedEvents = blockedPage.items.map((event) =>
    serializeListEvent(event, "blocked"),
  );
  const serializedIncludedEvents = includedPage.items.map((event) =>
    serializeListEvent(event, "included"),
  );

  return {
    ...data,
    events: serializedBlockedEvents,
    normalEvents: serializedIncludedEvents.filter(
      (event) => event.category === "normal",
    ),
    blockedEvents: serializedBlockedEvents,
    includedEvents: serializedIncludedEvents,
    blocked: {
      ...data.blocked,
      events: serializedBlockedEvents,
      pagination: blockedPage.pagination,
    },
    included: {
      ...data.included,
      events: serializedIncludedEvents,
      pagination: includedPage.pagination,
    },
  };
}

interface DemoRequestObservationDimensionValue {
  key: string;
  label: string;
  iconLabel?: string;
  country?: string;
  region?: string;
}

function demoDimensionString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function demoBotScoreBucket(value: unknown): string {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return "";
  if (score < 20) return "1-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-99";
}

function demoUserAgentLengthBucket(value: unknown): string {
  const length = Number(value);
  if (!Number.isFinite(length) || length <= 0) return "";
  if (length < 80) return "1-79";
  if (length < 160) return "80-159";
  if (length < 256) return "160-255";
  if (length < 512) return "256-511";
  return "512+";
}

function demoIpPrefix(value: unknown): string {
  const ip = demoDimensionString(value);
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    if (parts.length >= 4) return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return ip;
}

function demoRequestObservationDimensionValue(
  value: unknown,
  options?: Pick<
    DemoRequestObservationDimensionValue,
    "iconLabel" | "country" | "region"
  >,
): DemoRequestObservationDimensionValue {
  const label = demoDimensionString(value) || "Unknown";
  return {
    key: label,
    label,
    ...options,
  };
}

function demoRequestObservationDimensionValues(
  event: Record<string, unknown>,
  group: string,
  tab: string,
): DemoRequestObservationDimensionValue[] {
  if (group === "detection") {
    if (tab === "reason") {
      const reasons = Array.isArray(event.reasons)
        ? event.reasons.map(demoDimensionString).filter(Boolean)
        : demoDimensionString(event.reasons)
            .split(",")
            .map((reason) => reason.trim())
            .filter(Boolean);
      return [demoRequestObservationDimensionValue(reasons.join(","))];
    }
    if (tab === "category") {
      const category = demoDimensionString(event.category);
      return [demoRequestObservationDimensionValue(category)];
    }
    if (tab === "kind") {
      return [demoRequestObservationDimensionValue(event.kind)];
    }
    if (tab === "botScoreBucket") {
      return [
        demoRequestObservationDimensionValue(
          demoBotScoreBucket(event.botScore),
        ),
      ];
    }
    if (tab === "verifiedBotCategory") {
      return [demoRequestObservationDimensionValue(event.verifiedBotCategory)];
    }
  }

  if (group === "target") {
    if (tab === "site") {
      const siteId = demoDimensionString(event.siteId);
      const siteName =
        demoDimensionString(event.siteName) ||
        demoDimensionString(event.siteDomain) ||
        siteId;
      return [
        demoRequestObservationDimensionValue(siteName, {
          iconLabel: demoDimensionString(event.siteDomain) || undefined,
        }),
      ].map((value) => ({ ...value, key: siteId || value.key }));
    }
    if (tab === "hostname") {
      return [demoRequestObservationDimensionValue(event.hostname)];
    }
    if (tab === "pathname") {
      return [
        demoRequestObservationDimensionValue(
          demoDimensionString(event.pathname) || "/",
        ),
      ];
    }
    if (tab === "origin") {
      return [demoRequestObservationDimensionValue(event.origin)];
    }
  }

  if (group === "network") {
    if (tab === "asOrganization") {
      return [demoRequestObservationDimensionValue(event.asOrganization)];
    }
    if (tab === "asn") {
      return [demoRequestObservationDimensionValue(event.asn)];
    }
    if (tab === "country") {
      return [demoRequestObservationDimensionValue(event.country)];
    }
    if (tab === "region") {
      return [
        demoRequestObservationDimensionValue(event.region, {
          country: demoDimensionString(event.country) || undefined,
        }),
      ];
    }
    if (tab === "city") {
      return [
        demoRequestObservationDimensionValue(event.city, {
          country: demoDimensionString(event.country) || undefined,
          region: demoDimensionString(event.region) || undefined,
        }),
      ];
    }
    if (tab === "colo") {
      return [demoRequestObservationDimensionValue(event.colo)];
    }
  }

  if (group === "client") {
    if (tab === "ip") {
      return [demoRequestObservationDimensionValue(event.ip)];
    }
    if (tab === "userAgent") {
      return [demoRequestObservationDimensionValue(event.userAgent)];
    }
    if (tab === "userAgentLengthBucket") {
      return [
        demoRequestObservationDimensionValue(
          demoUserAgentLengthBucket(event.userAgentLength),
        ),
      ];
    }
    if (tab === "ipPrefix") {
      return [demoRequestObservationDimensionValue(demoIpPrefix(event.ip))];
    }
  }

  return [demoRequestObservationDimensionValue(event[tab])];
}

const DEMO_REQUEST_OBSERVATION_DEFAULT_LIMIT = 50;

function parseRequestObservationLimit(value: unknown): number {
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(
      100,
      Number.isFinite(parsed)
        ? Math.trunc(parsed)
        : DEMO_REQUEST_OBSERVATION_DEFAULT_LIMIT,
    ),
  );
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
  try {
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
  } catch (error) {
    if (error instanceof DemoInvalidCursorError) {
      return demoBadRequest("Invalid cursor");
    }
    throw error;
  }
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
