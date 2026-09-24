import type { NotificationPreferencesData } from "@/lib/dashboard-api/client/edge";
import { demoBadRequest, demoNotFound } from "@/lib/demo/realtime/envelope";
import { normalizeDemoSearch } from "@/lib/demo/realtime/filters";
import { demoPage, type DemoPagination } from "@/lib/demo/realtime/pagination";

export const demoNotFoundResponse = () => demoNotFound();

export const demoNotificationPreferences: NotificationPreferencesData = {
  inApp: true,
  email: true,
  webPush: false,
  attention: {
    reportsCreateUnread: false,
    milestonesCreateUnread: false,
    alertsCreateUnread: true,
  },
};

export function paginateDemoEnvelope(
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
  const comparisonEnabled =
    params.compare === "same" || params.compare === "previous";
  const comparisonMetric = params.metric === "visitors" ? "visitors" : "views";
  const comparisonSortBy =
    params.sortBy === "reference" || params.sortBy === "change"
      ? params.sortBy
      : "current";
  const getRowValue = (row: unknown, key: string): number => {
    if (!row || typeof row !== "object") return 0;
    const value = (row as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const getComparisonMetric = (row: unknown, side: "current" | "reference") =>
    getRowValue(
      side === "reference" && row && typeof row === "object"
        ? (row as Record<string, unknown>).reference
        : row,
      comparisonMetric,
    );
  const getComparisonChange = (row: unknown): number => {
    if (!row || typeof row !== "object") return Number.NEGATIVE_INFINITY;
    const change = (row as Record<string, unknown>).change;
    if (!change || typeof change !== "object") return Number.NEGATIVE_INFINITY;
    const metricChange = (change as Record<string, unknown>)[comparisonMetric];
    if (!metricChange || typeof metricChange !== "object") {
      return Number.NEGATIVE_INFINITY;
    }
    const relative = (metricChange as Record<string, unknown>).relative;
    return typeof relative === "number" && Number.isFinite(relative)
      ? relative
      : Number.NEGATIVE_INFINITY;
  };
  const getRowLabel = (row: unknown): string => {
    if (!row || typeof row !== "object") return "";
    const record = row as Record<string, unknown>;
    for (const key of [
      "label",
      "value",
      "pathname",
      "referrer",
      "channel",
      "key",
    ]) {
      const value = String(record[key] ?? "").trim();
      if (value) return value;
    }
    return "";
  };
  const compareRows = (left: unknown, right: unknown): number => {
    const direction = params.direction === "asc" ? 1 : -1;
    const leftValue = comparisonEnabled
      ? comparisonSortBy === "reference"
        ? getComparisonMetric(left, "reference")
        : comparisonSortBy === "change"
          ? getComparisonChange(left)
          : getComparisonMetric(left, "current")
      : getRowValue(
          left,
          params.sort === "sessions" || params.sort === "visitors"
            ? String(params.sort)
            : "views",
        );
    const rightValue = comparisonEnabled
      ? comparisonSortBy === "reference"
        ? getComparisonMetric(right, "reference")
        : comparisonSortBy === "change"
          ? getComparisonChange(right)
          : getComparisonMetric(right, "current")
      : getRowValue(
          right,
          params.sort === "sessions" || params.sort === "visitors"
            ? String(params.sort)
            : "views",
        );
    if (comparisonEnabled && comparisonSortBy === "change") {
      const leftNew =
        getComparisonMetric(left, "reference") === 0 &&
        getComparisonMetric(left, "current") > 0;
      const rightNew =
        getComparisonMetric(right, "reference") === 0 &&
        getComparisonMetric(right, "current") > 0;
      if (leftNew !== rightNew) {
        return direction === 1 ? (leftNew ? 1 : -1) : leftNew ? -1 : 1;
      }
    }
    return (
      (leftValue - rightValue) * direction ||
      getRowLabel(left).localeCompare(getRowLabel(right))
    );
  };
  const requestBinding = Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== "cursor"),
  );
  const page = demoPage(
    record.data,
    params,
    {
      operation,
      request: requestBinding,
    },
    fallbackLimit,
    maxLimit,
    true,
    {
      search: normalizeDemoSearch(params),
      getSearchValues: (row) => [getRowLabel(row)],
      compare:
        comparisonEnabled ||
        params.sort === "views" ||
        params.sort === "sessions" ||
        params.sort === "visitors"
          ? compareRows
          : undefined,
    },
  );
  return {
    ...record,
    data: page,
  };
}

export function demoShareTrendDimension(result: unknown): {
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

export function validateDemoAnalyticsRequest(
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

export function paginateDemoDetailCollection(
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

export function demoLoginTurnstileConfig(body?: Record<string, unknown>) {
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
