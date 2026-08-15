import { resolveReportingTimeZone } from "@/lib/dashboard/time-zone";
import { appNow } from "@/lib/edge/e2e-clock";
import { coerceNumber, ONE_DAY_MS } from "@/lib/edge/utils";

import {
  type DashboardFilters,
  DEFAULT_EVENT_RECORD_SORT,
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  type EventPayloadFilterRule,
  type EventPayloadFilterValue,
  type EventRecordSortKey,
  type FilterOptionKey,
  type Interval,
  type ListSort,
  type QueryWindow,
  type SessionListSortKey,
  type SortDirection,
  type VisitorListSortKey,
} from "./core-types";

export const MAX_PAGINATION_OFFSET = 20_000;

export function parseWindow(url: URL): QueryWindow | null {
  const nowMs = appNow();
  const defaultFrom = nowMs - ONE_DAY_MS;
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const parsedFrom = coerceNumber(rawFrom, null);
  const parsedTo = coerceNumber(rawTo, null);
  if (
    (rawFrom !== null && parsedFrom === null) ||
    (rawTo !== null && parsedTo === null)
  ) {
    return null;
  }
  const fromMs = Math.floor(parsedFrom ?? defaultFrom);
  const toMs = Math.floor(parsedTo ?? nowMs);
  const timeZone = resolveReportingTimeZone(url.searchParams.get("timeZone"));
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs < 0 ||
    toMs < fromMs
  ) {
    return null;
  }
  return { fromMs, toMs, nowMs, timeZone };
}

export function parseLimit(url: URL, fallback = 20, max = 500): number {
  const value = Math.floor(
    coerceNumber(url.searchParams.get("limit"), fallback) ?? fallback,
  );
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, value);
}

export function parseInterval(url: URL): Interval {
  const raw = (url.searchParams.get("interval") || "day").toLowerCase();
  if (raw === "minute" || raw === "hour" || raw === "week" || raw === "month")
    return raw;
  return "day";
}

export function parseBooleanSearchParam(url: URL, key: string): boolean {
  const value = (url.searchParams.get(key) || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function parseQueryLimit(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Math.floor(
    coerceNumber(url.searchParams.get(key), fallback) ?? fallback,
  );
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function paginationOffset(
  page: number,
  pageSize: number,
): number | null {
  const offset = (page - 1) * pageSize;
  return Number.isSafeInteger(offset) && offset <= MAX_PAGINATION_OFFSET
    ? offset
    : null;
}

export function parseSortDirection(url: URL): SortDirection {
  return (url.searchParams.get("sortDir") || "").trim().toLowerCase() === "asc"
    ? "asc"
    : "desc";
}

export function parseVisitorListSort(url: URL): ListSort<VisitorListSortKey> {
  const key = (url.searchParams.get("sortBy") || "").trim();
  if (
    key === "firstSeenAt" ||
    key === "lastSeenAt" ||
    key === "sessions" ||
    key === "views"
  ) {
    return { key, direction: parseSortDirection(url) };
  }
  return DEFAULT_VISITOR_LIST_SORT;
}

export function parseSessionListSort(url: URL): ListSort<SessionListSortKey> {
  const key = (url.searchParams.get("sortBy") || "").trim();
  if (key === "startedAt" || key === "durationMs" || key === "views") {
    return { key, direction: parseSortDirection(url) };
  }
  return DEFAULT_SESSION_LIST_SORT;
}

export function parseEventRecordSort(url: URL): ListSort<EventRecordSortKey> {
  const key = (url.searchParams.get("sortBy") || "").trim();
  if (key === "occurredAt" || key === "eventName" || key === "pathname") {
    return { key, direction: parseSortDirection(url) };
  }
  return DEFAULT_EVENT_RECORD_SORT;
}

export function parseListSearch(url: URL): string | undefined {
  const raw = url.searchParams.get("search");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().slice(0, 160);
  return normalized.length > 0 ? normalized : undefined;
}

export function parseEventName(url: URL): string | undefined {
  const raw = url.searchParams.get("eventName");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function parseEventFieldPath(url: URL): string | undefined {
  const raw = url.searchParams.get("fieldPath");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.slice(0, 240);
  return normalized.length > 0 ? normalized : undefined;
}

export function parseEventFieldValueType(url: URL): string | undefined {
  const raw = url.searchParams.get("fieldValueType");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "string" ||
    normalized === "number" ||
    normalized === "boolean" ||
    normalized === "null" ||
    normalized === "object" ||
    normalized === "array"
  ) {
    return normalized;
  }
  return undefined;
}

export function parseEventId(url: URL): string | undefined {
  const raw = url.searchParams.get("eventId");
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().slice(0, 128);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeFilterValue(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeEventPayloadFilterPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, 240);
  if (!normalized || normalized === "/") return null;
  if (normalized.startsWith("/")) {
    const segments = normalized
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    return segments.length > 0 ? `/${segments.join("/")}` : null;
  }

  const dotPath = normalized
    .replace(/^\$\.?/, "")
    .replace(/\[(?:\d+|\*)\]/g, ".*")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return dotPath.length > 0 ? `/${dotPath.join("/")}` : null;
}

export function normalizeEventPayloadFilterValue(
  value: unknown,
): EventPayloadFilterValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function parseEventPayloadFilters(
  value: string | null,
): EventPayloadFilterRule[] | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const rules: EventPayloadFilterRule[] = [];
  for (const item of parsed.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as {
      path?: unknown;
      operator?: unknown;
      value?: unknown;
    };
    const path = normalizeEventPayloadFilterPath(candidate.path);
    const operator =
      candidate.operator === "ne" || candidate.operator === "!=" ? "ne" : "eq";
    const filterValue = normalizeEventPayloadFilterValue(candidate.value);
    if (!path || filterValue === undefined) continue;
    rules.push({ path, operator, value: filterValue });
  }

  return rules.length > 0 ? rules : undefined;
}

export function parseFilters(url: URL): DashboardFilters {
  const geo =
    normalizeFilterValue(url.searchParams.get("geo")) ||
    normalizeFilterValue(url.searchParams.get("geoCountry")) ||
    normalizeFilterValue(url.searchParams.get("geoRegion")) ||
    normalizeFilterValue(url.searchParams.get("geoCity"));
  return {
    country: normalizeFilterValue(url.searchParams.get("country")),
    device: normalizeFilterValue(url.searchParams.get("device")),
    browser: normalizeFilterValue(url.searchParams.get("browser")),
    path: normalizeFilterValue(url.searchParams.get("path")),
    query: normalizeFilterValue(url.searchParams.get("query")),
    title: normalizeFilterValue(url.searchParams.get("title")),
    hostname: normalizeFilterValue(url.searchParams.get("hostname")),
    entry: normalizeFilterValue(url.searchParams.get("entry")),
    exit: normalizeFilterValue(url.searchParams.get("exit")),
    sourceDomain: normalizeFilterValue(url.searchParams.get("sourceDomain")),
    sourceLink: normalizeFilterValue(url.searchParams.get("sourceLink")),
    clientBrowser: normalizeFilterValue(url.searchParams.get("clientBrowser")),
    clientOsVersion: normalizeFilterValue(
      url.searchParams.get("clientOsVersion"),
    ),
    clientDeviceType: normalizeFilterValue(
      url.searchParams.get("clientDeviceType"),
    ),
    clientLanguage: normalizeFilterValue(
      url.searchParams.get("clientLanguage"),
    ),
    clientScreenSize: normalizeFilterValue(
      url.searchParams.get("clientScreenSize"),
    ),
    geo,
    geoContinent: normalizeFilterValue(url.searchParams.get("geoContinent")),
    geoTimezone: normalizeFilterValue(url.searchParams.get("geoTimezone")),
    geoOrganization: normalizeFilterValue(
      url.searchParams.get("geoOrganization"),
    ),
    eventPayloadFilters: parseEventPayloadFilters(
      url.searchParams.get("eventPayloadFilters"),
    ),
  };
}

export function parseFilterOptionKey(url: URL): FilterOptionKey | null {
  const raw = normalizeFilterValue(url.searchParams.get("filterKey"));
  if (!raw) return null;
  const keys: FilterOptionKey[] = [
    "country",
    "device",
    "browser",
    "path",
    "title",
    "hostname",
    "entry",
    "exit",
    "sourceDomain",
    "sourceLink",
    "clientBrowser",
    "clientOsVersion",
    "clientDeviceType",
    "clientLanguage",
    "clientScreenSize",
    "geo",
    "geoContinent",
    "geoTimezone",
    "geoOrganization",
  ];
  return keys.includes(raw as FilterOptionKey)
    ? (raw as FilterOptionKey)
    : null;
}

export function withoutFilterKey(
  filters: DashboardFilters,
  key: FilterOptionKey,
): DashboardFilters {
  const { [key]: _, ...next } = filters;
  return next;
}

export function parseBooleanFlag(url: URL, key: string): boolean {
  return parseBooleanSearchParam(url, key);
}

export function customEventJsonTypeLabel(valueType: number): string {
  if (valueType === 1) return "string";
  if (valueType === 2) return "number";
  if (valueType === 3) return "boolean";
  if (valueType === 4) return "object";
  if (valueType === 5) return "array";
  return "null";
}

export function customEventJsonTypeCode(valueType: string): number | null {
  if (valueType === "null") return 0;
  if (valueType === "string") return 1;
  if (valueType === "number") return 2;
  if (valueType === "boolean") return 3;
  if (valueType === "object") return 4;
  if (valueType === "array") return 5;
  return null;
}
