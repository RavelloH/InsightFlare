import { resolveReportingTimeZone } from "@/lib/dashboard/time-zone";
import { appNow } from "@/lib/edge/e2e-clock";
import { coerceNumber, ONE_DAY_MS } from "@/lib/edge/utils";

import {
  DEFAULT_EVENT_RECORD_SORT,
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  type EventRecordSortKey,
  type FilterOptionKey,
  type Interval,
  type ListSort,
  type QueryWindow,
  type SessionListSortKey,
  type SortDirection,
  type VisitorListSortKey,
} from "./core-types";

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
  const startMs = Math.floor(parsedFrom ?? defaultFrom);
  const endExclusiveMs = Math.floor(parsedTo ?? nowMs);
  const timeZone = resolveReportingTimeZone(url.searchParams.get("timeZone"));
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endExclusiveMs) ||
    startMs < 0 ||
    endExclusiveMs <= startMs
  ) {
    return null;
  }
  return { startMs, endExclusiveMs, nowMs, timeZone };
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

export function parseFilterOptionKey(url: URL): FilterOptionKey | null {
  const raw = normalizeFilterValue(url.searchParams.get("filterKey"));
  if (!raw) return null;
  const keys: FilterOptionKey[] = [
    "geo.country",
    "client.deviceType",
    "client.browser",
    "client.browserVersion",
    "client.browserEngine",
    "client.os",
    "client.osVersion",
    "client.language",
    "client.screenSize",
    "utm.source",
    "utm.medium",
    "utm.campaign",
    "utm.term",
    "utm.content",
    "page.path",
    "page.title",
    "page.hostname",
    "session.entryPath",
    "session.exitPath",
    "referrer.domain",
    "referrer.url",
    "traffic.channel",
    "client.osVersion",
    "client.language",
    "client.screenSize",
    "geo.region",
    "geo.city",
    "geo.continent",
    "geo.timeZone",
    "geo.organization",
    "event.name",
  ];
  return keys.includes(raw as FilterOptionKey)
    ? (raw as FilterOptionKey)
    : null;
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
