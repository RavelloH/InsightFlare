import {
  addCalendarMonths,
  browserTimeZone,
  endOfZonedDay,
  resolveReportingTimeZone,
  startOfZonedDay,
  startOfZonedMonth,
  startOfZonedWeek,
  startOfZonedYear,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/dashboard/time-zone";

export type RangePreset =
  | "30m"
  | "1h"
  | "today"
  | "yesterday"
  | "thisWeek"
  | "thisMonth"
  | "thisYear"
  | "24h"
  | "7d"
  | "30d"
  | "90d"
  | "6m"
  | "12m"
  | "all"
  | "custom";

export type DashboardInterval = "minute" | "hour" | "day" | "week" | "month";

export interface CustomTimeRange {
  from: number;
  to: number;
}

export interface TimeWindow {
  preset: RangePreset;
  from: number;
  to: number;
  interval: DashboardInterval;
  timeZone: string;
}

export type EventPayloadFilterOperator = "eq" | "ne";

export type EventPayloadFilterValue = string | number | boolean | null;

export interface EventPayloadFilterRule {
  path: string;
  operator: EventPayloadFilterOperator;
  value: EventPayloadFilterValue;
}

export interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
  path?: string;
  query?: string;
  title?: string;
  hostname?: string;
  entry?: string;
  exit?: string;
  sourceDomain?: string;
  sourceLink?: string;
  clientBrowser?: string;
  clientOsVersion?: string;
  clientDeviceType?: string;
  clientLanguage?: string;
  clientScreenSize?: string;
  geo?: string;
  geoContinent?: string;
  geoTimezone?: string;
  geoOrganization?: string;
  eventPayloadFilters?: EventPayloadFilterRule[];
}

export const DEFAULT_RANGE_PRESET: RangePreset = "30d";

const RANGE_PRESETS: readonly RangePreset[] = [
  "30m",
  "1h",
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "thisYear",
  "24h",
  "7d",
  "30d",
  "90d",
  "6m",
  "12m",
  "all",
  "custom",
] as const;

const INTERVAL_ORDER: readonly DashboardInterval[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 366 * DAY_MS;

function normalizeFilterValue(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeEventPayloadFilterPath(value: unknown): string | null {
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

function normalizeEventPayloadFilterValue(
  value: unknown,
): EventPayloadFilterValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function parseEventPayloadFiltersParam(
  value: string | null | undefined,
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

function isRangePreset(value: string): value is RangePreset {
  return RANGE_PRESETS.includes(value as RangePreset);
}

function isValidCustomRange(
  value: CustomTimeRange | null | undefined,
): value is CustomTimeRange {
  if (!value) return false;
  return (
    Number.isFinite(value.from) &&
    Number.isFinite(value.to) &&
    value.from >= 0 &&
    value.to >= 0 &&
    value.from < value.to
  );
}

function subtractZonedMonths(
  now: number,
  months: number,
  timeZone: string,
): number {
  const parts = zonedParts(now, timeZone);
  const target = addCalendarMonths(parts, -months);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    year: target.year,
    month: target.month,
    day: target.day,
  });
}

function rangeBounds(
  preset: RangePreset,
  now: number,
  timeZone: string,
  customRange?: CustomTimeRange,
): { from: number; to: number } {
  if (preset === "30m") {
    return { from: now - 30 * MINUTE_MS, to: now };
  }
  if (preset === "1h") {
    return { from: now - HOUR_MS, to: now };
  }
  if (preset === "today") {
    return { from: startOfZonedDay(now, timeZone), to: now };
  }
  if (preset === "yesterday") {
    const startToday = startOfZonedDay(now, timeZone);
    const startYesterday = startOfZonedDay(startToday - 1, timeZone);
    return {
      from: startYesterday,
      to: startToday - 1,
    };
  }
  if (preset === "thisWeek") {
    return { from: startOfZonedWeek(now, timeZone), to: now };
  }
  if (preset === "thisMonth") {
    return { from: startOfZonedMonth(now, timeZone), to: now };
  }
  if (preset === "thisYear") {
    return { from: startOfZonedYear(now, timeZone), to: now };
  }
  if (preset === "24h") {
    return { from: now - DAY_MS, to: now };
  }
  if (preset === "7d") {
    return { from: startOfZonedDay(now, timeZone) - 7 * DAY_MS, to: now };
  }
  if (preset === "30d") {
    return { from: startOfZonedDay(now, timeZone) - 30 * DAY_MS, to: now };
  }
  if (preset === "90d") {
    return { from: startOfZonedDay(now, timeZone) - 90 * DAY_MS, to: now };
  }
  if (preset === "6m") {
    return {
      from: startOfZonedMonth(subtractZonedMonths(now, 6, timeZone), timeZone),
      to: now,
    };
  }
  if (preset === "12m") {
    return {
      from: startOfZonedMonth(subtractZonedMonths(now, 12, timeZone), timeZone),
      to: now,
    };
  }
  if (preset === "all") {
    return { from: 0, to: now };
  }
  if (preset === "custom" && isValidCustomRange(customRange)) {
    return {
      from: Math.max(0, customRange.from),
      to: Math.max(customRange.from + 1, customRange.to),
    };
  }
  return rangeBounds(DEFAULT_RANGE_PRESET, now, timeZone);
}

function spanMs(from: number, to: number): number {
  return Math.max(1, to - from);
}

export function resolveRangePreset(
  value: string | null | undefined,
): RangePreset {
  if (!value) return DEFAULT_RANGE_PRESET;
  return isRangePreset(value) ? value : DEFAULT_RANGE_PRESET;
}

export function allowedIntervalsForRange(
  from: number,
  to: number,
): DashboardInterval[] {
  const span = spanMs(from, to);
  const allowed = INTERVAL_ORDER.filter((interval) => {
    if (interval === "minute") return span < HOUR_MS + MINUTE_MS;
    if (interval === "hour") return span < 8 * DAY_MS;
    if (interval === "day") return span < 91 * DAY_MS;
    if (interval === "week") return span < YEAR_MS + DAY_MS;
    return true;
  });

  return allowed.length > 0 ? [...allowed] : ["month"];
}

export function finestIntervalForRange(
  from: number,
  to: number,
): DashboardInterval {
  const span = spanMs(from, to);
  if (span <= HOUR_MS) return "minute";
  if (span <= DAY_MS) return "hour";
  if (span < 91 * DAY_MS) return "day";
  return "month";
}

export function clampIntervalForRange(
  interval: DashboardInterval | null | undefined,
  from: number,
  to: number,
): DashboardInterval {
  if (!interval) return finestIntervalForRange(from, to);
  const allowed = allowedIntervalsForRange(from, to);
  if (allowed.includes(interval)) return interval;
  return finestIntervalForRange(from, to);
}

export function resolveTimeWindow(
  range: string | null | undefined,
  now = Date.now(),
  options?: {
    customRange?: CustomTimeRange;
    interval?: DashboardInterval | null;
    timeZone?: string | null;
  },
): TimeWindow {
  const preset = resolveRangePreset(range);
  const timeZone = resolveReportingTimeZone(
    options?.timeZone,
    typeof window === "undefined" ? null : browserTimeZone(),
  );
  const bounds = rangeBounds(preset, now, timeZone, options?.customRange);
  const interval = clampIntervalForRange(
    options?.interval,
    bounds.from,
    bounds.to,
  );
  return {
    preset,
    from: bounds.from,
    to: bounds.to,
    interval,
    timeZone,
  };
}

export function parseDashboardFiltersFromSearchParams(
  searchParams: URLSearchParams,
): DashboardFilters {
  return {
    country: normalizeFilterValue(searchParams.get("country")),
    device: normalizeFilterValue(searchParams.get("device")),
    browser: normalizeFilterValue(searchParams.get("browser")),
    path: normalizeFilterValue(searchParams.get("path")),
    query: normalizeFilterValue(searchParams.get("query")),
    title: normalizeFilterValue(searchParams.get("title")),
    hostname: normalizeFilterValue(searchParams.get("hostname")),
    entry: normalizeFilterValue(searchParams.get("entry")),
    exit: normalizeFilterValue(searchParams.get("exit")),
    sourceDomain: normalizeFilterValue(searchParams.get("sourceDomain")),
    sourceLink: normalizeFilterValue(searchParams.get("sourceLink")),
    clientBrowser: normalizeFilterValue(searchParams.get("clientBrowser")),
    clientOsVersion: normalizeFilterValue(searchParams.get("clientOsVersion")),
    clientDeviceType: normalizeFilterValue(
      searchParams.get("clientDeviceType"),
    ),
    clientLanguage: normalizeFilterValue(searchParams.get("clientLanguage")),
    clientScreenSize: normalizeFilterValue(
      searchParams.get("clientScreenSize"),
    ),
    geo: normalizeFilterValue(searchParams.get("geo")),
    geoContinent: normalizeFilterValue(searchParams.get("geoContinent")),
    geoTimezone: normalizeFilterValue(searchParams.get("geoTimezone")),
    geoOrganization: normalizeFilterValue(searchParams.get("geoOrganization")),
    eventPayloadFilters: parseEventPayloadFiltersParam(
      searchParams.get("eventPayloadFilters"),
    ),
  };
}

function applyFiltersToParams(
  params: URLSearchParams,
  filters?: DashboardFilters,
): URLSearchParams {
  if (!filters) return params;
  if (filters.country) params.set("country", filters.country);
  if (filters.device) params.set("device", filters.device);
  if (filters.browser) params.set("browser", filters.browser);
  if (filters.path) params.set("path", filters.path);
  if (filters.query) params.set("query", filters.query);
  if (filters.title) params.set("title", filters.title);
  if (filters.hostname) params.set("hostname", filters.hostname);
  if (filters.entry) params.set("entry", filters.entry);
  if (filters.exit) params.set("exit", filters.exit);
  if (filters.sourceDomain) params.set("sourceDomain", filters.sourceDomain);
  if (filters.sourceLink) params.set("sourceLink", filters.sourceLink);
  if (filters.clientBrowser) params.set("clientBrowser", filters.clientBrowser);
  if (filters.clientOsVersion)
    params.set("clientOsVersion", filters.clientOsVersion);
  if (filters.clientDeviceType)
    params.set("clientDeviceType", filters.clientDeviceType);
  if (filters.clientLanguage)
    params.set("clientLanguage", filters.clientLanguage);
  if (filters.clientScreenSize)
    params.set("clientScreenSize", filters.clientScreenSize);
  if (filters.geo) params.set("geo", filters.geo);
  if (filters.geoContinent) params.set("geoContinent", filters.geoContinent);
  if (filters.geoTimezone) params.set("geoTimezone", filters.geoTimezone);
  if (filters.geoOrganization)
    params.set("geoOrganization", filters.geoOrganization);
  if (filters.eventPayloadFilters?.length) {
    params.set(
      "eventPayloadFilters",
      JSON.stringify(filters.eventPayloadFilters),
    );
  }
  return params;
}

export function withRangeAndFilters(
  pathname: string,
  range: RangePreset,
  filters?: DashboardFilters,
): string {
  const params = applyFiltersToParams(new URLSearchParams(), filters);
  params.set("range", range);
  return `${pathname}?${params.toString()}`;
}

export function normalizeCustomDateRange(
  range: { from?: Date; to?: Date } | null | undefined,
  timeZone?: string | null,
): CustomTimeRange | null {
  if (!range?.from || !range?.to) return null;
  const resolvedTimeZone = resolveReportingTimeZone(
    timeZone,
    typeof window === "undefined" ? null : browserTimeZone(),
  );
  const from = zonedTimeToUtcMs(resolvedTimeZone, {
    year: range.from.getFullYear(),
    month: range.from.getMonth() + 1,
    day: range.from.getDate(),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const to = endOfZonedDay(
    zonedTimeToUtcMs(resolvedTimeZone, {
      year: range.to.getFullYear(),
      month: range.to.getMonth() + 1,
      day: range.to.getDate(),
      hour: 12,
      minute: 0,
      second: 0,
      millisecond: 0,
    }),
    resolvedTimeZone,
  );
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return { from, to };
}
