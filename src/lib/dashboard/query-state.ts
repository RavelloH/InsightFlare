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
}

export interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
  eventType?: string;
}

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
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 366 * DAY_MS;

function normalizeFilterValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

function isRangePreset(value: string): value is RangePreset {
  return RANGE_PRESETS.includes(value as RangePreset);
}

function isValidCustomRange(value: CustomTimeRange | null | undefined): value is CustomTimeRange {
  if (!value) return false;
  return (
    Number.isFinite(value.from) &&
    Number.isFinite(value.to) &&
    value.from >= 0 &&
    value.to >= 0 &&
    value.from < value.to
  );
}

function startOfDay(date: Date): number {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

function endOfDay(date: Date): number {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next.getTime();
}

function startOfWeek(date: Date): number {
  const next = new Date(date);
  const weekday = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - weekday);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

function startOfMonth(date: Date): number {
  const next = new Date(date);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

function startOfYear(date: Date): number {
  const next = new Date(date);
  next.setMonth(0, 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

function subtractMonths(now: number, months: number): number {
  const next = new Date(now);
  next.setMonth(next.getMonth() - months);
  return next.getTime();
}

function rangeBounds(
  preset: RangePreset,
  now: number,
  customRange?: CustomTimeRange,
): { from: number; to: number } {
  const current = new Date(now);

  if (preset === "30m") {
    return { from: now - 30 * MINUTE_MS, to: now };
  }
  if (preset === "1h") {
    return { from: now - HOUR_MS, to: now };
  }
  if (preset === "today") {
    return { from: startOfDay(current), to: now };
  }
  if (preset === "yesterday") {
    const startToday = startOfDay(current);
    return {
      from: startToday - DAY_MS,
      to: startToday - 1,
    };
  }
  if (preset === "thisWeek") {
    return { from: startOfWeek(current), to: now };
  }
  if (preset === "thisMonth") {
    return { from: startOfMonth(current), to: now };
  }
  if (preset === "thisYear") {
    return { from: startOfYear(current), to: now };
  }
  if (preset === "24h") {
    return { from: now - DAY_MS, to: now };
  }
  if (preset === "30d") {
    return { from: now - 30 * DAY_MS, to: now };
  }
  if (preset === "90d") {
    return { from: now - 90 * DAY_MS, to: now };
  }
  if (preset === "6m") {
    return { from: subtractMonths(now, 6), to: now };
  }
  if (preset === "12m") {
    return { from: subtractMonths(now, 12), to: now };
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
  return {
    from: now - 7 * DAY_MS,
    to: now,
  };
}

function spanMs(from: number, to: number): number {
  return Math.max(1, to - from);
}

export function resolveRangePreset(value: string | null | undefined): RangePreset {
  if (!value) return "7d";
  return isRangePreset(value) ? value : "7d";
}

export function allowedIntervalsForRange(from: number, to: number): DashboardInterval[] {
  const span = spanMs(from, to);
  const allowed = INTERVAL_ORDER.filter((interval) => {
    if (interval === "minute") return span <= HOUR_MS;
    if (interval === "hour") return span <= 7 * DAY_MS;
    if (interval === "day") return span <= 90 * DAY_MS;
    if (interval === "week") return span <= YEAR_MS;
    return true;
  });

  return allowed.length > 0 ? [...allowed] : ["month"];
}

export function finestIntervalForRange(from: number, to: number): DashboardInterval {
  const allowed = allowedIntervalsForRange(from, to);
  return allowed[0] || "month";
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
  },
): TimeWindow {
  const preset = resolveRangePreset(range);
  const bounds = rangeBounds(preset, now, options?.customRange);
  const interval = clampIntervalForRange(options?.interval, bounds.from, bounds.to);
  return {
    preset,
    from: bounds.from,
    to: bounds.to,
    interval,
  };
}

export function parseDashboardFiltersFromSearchParams(searchParams: URLSearchParams): DashboardFilters {
  return {
    country: normalizeFilterValue(searchParams.get("country")),
    device: normalizeFilterValue(searchParams.get("device")),
    browser: normalizeFilterValue(searchParams.get("browser")),
    eventType: normalizeFilterValue(searchParams.get("eventType")),
  };
}

function applyFiltersToParams(params: URLSearchParams, filters?: DashboardFilters): URLSearchParams {
  if (!filters) return params;
  if (filters.country) params.set("country", filters.country);
  if (filters.device) params.set("device", filters.device);
  if (filters.browser) params.set("browser", filters.browser);
  if (filters.eventType) params.set("eventType", filters.eventType);
  return params;
}

export function withRangeAndFilters(pathname: string, range: RangePreset, filters?: DashboardFilters): string {
  const params = applyFiltersToParams(new URLSearchParams(), filters);
  params.set("range", range);
  return `${pathname}?${params.toString()}`;
}

export function normalizeCustomDateRange(range: { from?: Date; to?: Date } | null | undefined): CustomTimeRange | null {
  if (!range?.from || !range?.to) return null;
  const from = startOfDay(range.from);
  const to = endOfDay(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return { from, to };
}
