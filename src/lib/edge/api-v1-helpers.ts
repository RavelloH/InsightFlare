import { getRequestId, jsonResponse } from "@/lib/response";

import type { ApiKeyScope } from "./api-key-store";

export const API_V1_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;
export const BATCH_MAX_REQUESTS = 20;

export const TIME_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;

export type TimePreset = (typeof TIME_PRESETS)[number];

export const INTERVALS = ["minute", "hour", "day", "week", "month"] as const;
export type ApiInterval = (typeof INTERVALS)[number];

export const ANALYTICS_METRICS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "bounceRate",
  "avgDurationMs",
  "viewsPerSession",
  "events",
] as const;

export const ANALYTICS_DIMENSIONS = [
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "session.entryPath",
  "session.exitPath",
  "referrer.domain",
  "referrer.url",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "client.osVersion",
  "client.deviceType",
  "client.language",
  "client.screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "event.name",
] as const;

export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "notExists",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface ApiMeta {
  requestId?: string;
  generatedAt: string;
  [key: string]: unknown;
}

export interface TimeRange {
  from: string;
  to: string;
  timeZone: string;
}

export interface ParsedTimeRange extends TimeRange {
  fromMs: number;
  toMs: number;
}

export interface ParsedSort {
  field: string;
  direction: "asc" | "desc";
}

export interface CursorPagination {
  limit: number;
  cursor: string | null;
}

export interface ComplexFilter {
  field: string;
  op: FilterOperator;
  value?: unknown;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FILTER_PARAM_RE = /^filter\[(.+)]$/;
const METRIC_SET = new Set<string>(ANALYTICS_METRICS);
const DIMENSION_SET = new Set<string>(ANALYTICS_DIMENSIONS);
const PRESET_SET = new Set<string>(TIME_PRESETS);
const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

export function generatedAt(): string {
  return new Date().toISOString();
}

export function getRequestMeta(request?: Request | null): ApiMeta {
  return {
    ...(request ? { requestId: getRequestId(request) } : {}),
    generatedAt: generatedAt(),
  };
}

export function jsonSuccess(
  data: unknown,
  options: {
    request?: Request;
    status?: number;
    meta?: Record<string, unknown>;
    links?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Response {
  return jsonResponse(
    {
      data,
      ...(options.links ? { links: options.links } : {}),
      meta: { ...getRequestMeta(options.request), ...(options.meta ?? {}) },
    },
    options.status ?? 200,
    options.headers,
  );
}

export function jsonList(
  data: unknown[],
  options: {
    request?: Request;
    status?: number;
    meta?: Record<string, unknown>;
    links?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Response {
  return jsonSuccess(data, options);
}

export function jsonPaginated(
  data: unknown[],
  pagination: { limit: number; nextCursor: string | null; hasMore: boolean },
  options: {
    request?: Request;
    status?: number;
    meta?: Record<string, unknown>;
    links?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Response {
  return jsonResponse(
    {
      data,
      pagination,
      ...(options.links ? { links: options.links } : {}),
      meta: { ...getRequestMeta(options.request), ...(options.meta ?? {}) },
    },
    options.status ?? 200,
    options.headers,
  );
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  request?: Request,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      meta: getRequestMeta(request),
    },
    status,
  );
}

export function methodNotAllowed(request: Request): Response {
  return jsonError(
    "method_not_allowed",
    "Method Not Allowed",
    405,
    undefined,
    request,
  );
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseIsoDateTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function offsetMsFor(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const hour = values.hour === "24" ? "00" : values.hour;
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - at.getTime();
}

function zonedMidnightUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number {
  const guess = Date.UTC(year, month, day, 0, 0, 0);
  const first = guess - offsetMsFor(timeZone, new Date(guess));
  return guess - offsetMsFor(timeZone, new Date(first));
}

function zonedParts(timeZone: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month) - 1,
    day: Number(values.day),
    weekday: String(values.weekday || "Sun"),
  };
}

function addDays(ms: number, days: number): number {
  return ms + days * ONE_DAY_MS;
}

export function parsePreset(
  preset: string,
  timeZone = "UTC",
  now = new Date(),
): ParsedTimeRange | null {
  if (!PRESET_SET.has(preset)) return null;
  if (!isValidTimeZone(timeZone)) return null;

  const parts = zonedParts(timeZone, now);
  const today = zonedMidnightUtcMs(
    timeZone,
    parts.year,
    parts.month,
    parts.day,
  );
  let fromMs = today;
  let toMs = addDays(today, 1);

  if (preset === "yesterday") {
    fromMs = addDays(today, -1);
    toMs = today;
  } else if (preset === "last_7_days") {
    fromMs = addDays(today, -6);
    toMs = addDays(today, 1);
  } else if (preset === "last_30_days") {
    fromMs = addDays(today, -29);
    toMs = addDays(today, 1);
  } else if (preset === "this_week" || preset === "last_week") {
    const weekdayIndex = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ].indexOf(parts.weekday);
    const daysFromMonday = (weekdayIndex + 6) % 7;
    const weekStart = addDays(today, -daysFromMonday);
    fromMs = preset === "this_week" ? weekStart : addDays(weekStart, -7);
    toMs = preset === "this_week" ? addDays(weekStart, 7) : weekStart;
  } else if (preset === "this_month" || preset === "last_month") {
    const thisMonth = zonedMidnightUtcMs(timeZone, parts.year, parts.month, 1);
    const nextMonth = zonedMidnightUtcMs(
      timeZone,
      parts.year,
      parts.month + 1,
      1,
    );
    const previousMonth = zonedMidnightUtcMs(
      timeZone,
      parts.year,
      parts.month - 1,
      1,
    );
    fromMs = preset === "this_month" ? thisMonth : previousMonth;
    toMs = preset === "this_month" ? nextMonth : thisMonth;
  }

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    timeZone,
    fromMs,
    toMs,
  };
}

export function parseTimeRange(
  url: URL,
  now = new Date(),
): ParsedTimeRange | Response {
  const timeZone = url.searchParams.get("timeZone") || "UTC";
  if (!isValidTimeZone(timeZone)) {
    return jsonError("validation_failed", "Invalid timeZone", 400, {
      field: "timeZone",
    });
  }

  const preset = url.searchParams.get("preset");
  const hasFromTo = url.searchParams.has("from") || url.searchParams.has("to");
  if (preset && hasFromTo) {
    return jsonError(
      "validation_failed",
      "preset cannot be combined with from or to",
      400,
      { field: "preset" },
    );
  }
  if (preset) {
    const parsedPreset = parsePreset(preset, timeZone, now);
    if (!parsedPreset) {
      return jsonError("validation_failed", "Invalid time preset", 400, {
        field: "preset",
      });
    }
    return parsedPreset;
  }

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const toMs = parseIsoDateTime(toRaw) ?? now.getTime();
  const fromMs = parseIsoDateTime(fromRaw) ?? toMs - 7 * ONE_DAY_MS;

  if (
    (fromRaw !== null && parseIsoDateTime(fromRaw) === null) ||
    (toRaw !== null && parseIsoDateTime(toRaw) === null) ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs < 0 ||
    toMs <= fromMs
  ) {
    return jsonError("validation_failed", "Invalid time range", 400, {
      fields: ["from", "to"],
    });
  }

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    timeZone,
    fromMs,
    toMs,
  };
}

export function parseMetrics(
  raw: string | null,
  fallback: readonly AnalyticsMetric[] = ["views", "sessions", "visitors"],
): AnalyticsMetric[] | Response {
  if (!raw) return [...fallback];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.find((value) => !METRIC_SET.has(value));
  if (invalid) {
    return jsonError("validation_failed", "Unknown metric", 400, {
      metric: invalid,
    });
  }
  return [...new Set(values)] as AnalyticsMetric[];
}

export function validateDimension(
  value: string,
): AnalyticsDimension | Response {
  if (DIMENSION_SET.has(value)) return value as AnalyticsDimension;
  return jsonError("validation_failed", "Unknown dimension", 400, {
    dimension: value,
  });
}

const UNSUPPORTED_CROSS_BREAKDOWN = new Set([
  "session.entryPath",
  "session.exitPath",
  "event.name",
]);

export function validateCrossBreakdownDimension(
  value: string,
): AnalyticsDimension | Response {
  const base = validateDimension(value);
  if (base instanceof Response) return base;
  if (UNSUPPORTED_CROSS_BREAKDOWN.has(value)) {
    return jsonError(
      "validation_failed",
      "Dimension not supported for cross-breakdowns",
      400,
      { dimension: value },
    );
  }
  return base;
}

export function parseFilter(url: URL): Record<string, string> | Response {
  const filters: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const match = key.match(FILTER_PARAM_RE);
    if (!match) continue;
    const field = match[1] || "";
    if (!DIMENSION_SET.has(field)) {
      return jsonError("validation_failed", "Unknown filter field", 400, {
        field,
      });
    }
    filters[field] = value.slice(0, 500);
  }
  return filters;
}

export function parseComplexFilters(
  input: unknown,
): ComplexFilter[] | Response {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    return jsonError("validation_failed", "filters must be an array", 400, {
      field: "filters",
    });
  }
  const filters: ComplexFilter[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      return jsonError("validation_failed", "Invalid filter", 400);
    }
    const candidate = item as Record<string, unknown>;
    const field = String(candidate.field || "");
    const op = String(candidate.op || "eq");
    if (!DIMENSION_SET.has(field)) {
      return jsonError("validation_failed", "Unknown filter field", 400, {
        field,
      });
    }
    if (!OPERATOR_SET.has(op)) {
      return jsonError("validation_failed", "Invalid filter operator", 400, {
        op,
      });
    }
    filters.push({
      field,
      op: op as FilterOperator,
      ...(candidate.value !== undefined ? { value: candidate.value } : {}),
    });
  }
  return filters;
}

export function parseSort(raw: string | null): ParsedSort | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return {
    field: trimmed.startsWith("-") ? trimmed.slice(1) : trimmed,
    direction: trimmed.startsWith("-") ? "desc" : "asc",
  };
}

export function parseCursorPagination(url: URL): CursorPagination | Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    return jsonError("validation_failed", "Invalid limit", 400, {
      field: "limit",
    });
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !/^[A-Za-z0-9._~:-]{1,512}$/.test(cursor)) {
    return jsonError("validation_failed", "Invalid cursor", 400, {
      field: "cursor",
    });
  }
  return { limit: Math.min(limit, MAX_PAGE_LIMIT), cursor };
}

export function requireScope(
  scopes: ApiKeyScope[],
  scope: ApiKeyScope,
  request: Request,
): Response | null {
  if (scopes.includes(scope)) return null;
  return jsonError(
    "insufficient_scope",
    "The API key does not have the required scope.",
    403,
    { requiredScope: scope },
    request,
  );
}

export function epochSecondsToIso(
  value: number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value * 1000).toISOString();
}

export function normalizeUnknownDirect(value: unknown): {
  key: string;
  label: string;
} {
  const raw = String(value ?? "").trim();
  if (!raw) return { key: "__unknown__", label: "Unknown" };
  if (raw.toLowerCase() === "direct")
    return { key: "__direct__", label: "Direct" };
  return { key: raw, label: raw };
}
