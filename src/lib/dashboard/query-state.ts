import {
  addCalendarMonths,
  endOfZonedDay,
  resolveReportingTimeZone,
  startOfZonedDay,
  startOfZonedMonth,
  startOfZonedWeek,
  startOfZonedYear,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/dashboard/time-zone";
import {
  analyticsFilterRegistry,
  FILTER_DOCUMENT_VERSION,
  type FilterDocument,
  filterScopePreferenceFromDocument,
  parseFilterParams,
  serializeFilterParams,
} from "@/lib/filter-contract";
import {
  attachFilterScopePreference,
  type FilterScopePreference,
  parseFilterScopePreference,
  serializeFilterScopePreference,
} from "@/lib/filter-contract";

import { serializeDashboardSearchParams } from "./filter-state";

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

function cacheAlignedPresetNow(now: number): number {
  // Keep rolling preset requests stable for one minute so separate dashboard
  // loads resolve to the same Cache API key without hiding the current minute.
  return Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS - 1;
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
      to: startToday,
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

  return [...allowed];
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
  const timeZone = resolveReportingTimeZone(options?.timeZone);
  const bounds = rangeBounds(
    preset,
    preset === "custom" && isValidCustomRange(options?.customRange)
      ? now
      : cacheAlignedPresetNow(now),
    timeZone,
    options?.customRange,
  );
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

export function parseFilterDocumentFromSearchParams(
  searchParams: URLSearchParams,
): FilterDocument {
  return attachFilterScopePreference(
    parseFilterParams(searchParams, analyticsFilterRegistry),
    parseFilterScopePreference(searchParams),
  );
}

export function parseFilterScopeFromSearchParams(
  searchParams: URLSearchParams,
): FilterScopePreference {
  return parseFilterScopePreference(searchParams);
}

export function serializeFilterScopeToSearchParams(
  searchParams: URLSearchParams,
  preference: FilterScopePreference,
): URLSearchParams {
  return serializeFilterScopePreference(searchParams, preference);
}

export function withRangeAndFilters(
  pathname: string,
  range: RangePreset,
  filters?: FilterDocument,
): string {
  const params = serializeFilterParams(
    filters ?? { version: FILTER_DOCUMENT_VERSION, root: null },
    analyticsFilterRegistry,
  );
  params.set("range", range);
  const scopePreference = filterScopePreferenceFromDocument(filters);
  if (scopePreference && filters?.root) {
    return `${pathname}?${serializeDashboardSearchParams(
      serializeFilterScopePreference(params, scopePreference),
    )}`;
  }
  return `${pathname}?${serializeDashboardSearchParams(params)}`;
}

export function normalizeCustomDateRange(
  range: { from?: Date; to?: Date } | null | undefined,
  timeZone?: string | null,
): CustomTimeRange | null {
  if (!range?.from || !range?.to) return null;
  const resolvedTimeZone = resolveReportingTimeZone(timeZone);
  const from = zonedTimeToUtcMs(resolvedTimeZone, {
    year: range.from.getFullYear(),
    month: range.from.getMonth() + 1,
    day: range.from.getDate(),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const toInclusive = endOfZonedDay(
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
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(toInclusive) ||
    from >= toInclusive
  )
    return null;
  return { from, to: toInclusive + 1 };
}
