import { type DateRange } from "react-day-picker";

import { zonedParts } from "@/lib/analytics/time-zone";
import { intlLocale } from "@/lib/dashboard/format";
import {
  type DashboardInterval,
  type RangePreset,
} from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
export const INTERVAL_ORDER: readonly DashboardInterval[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;
export const ROLLING_RANGE_PRESETS = new Set<RangePreset>([
  "30m",
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
  "6m",
  "12m",
]);
export function rangeLabel(messages: AppMessages, range: RangePreset): string {
  if (range === "30m") return messages.ranges.last30m;
  if (range === "1h") return messages.ranges.last1h;
  if (range === "today") return messages.ranges.today;
  if (range === "yesterday") return messages.ranges.yesterday;
  if (range === "thisWeek") return messages.ranges.thisWeek;
  if (range === "thisMonth") return messages.ranges.thisMonth;
  if (range === "thisYear") return messages.ranges.thisYear;
  if (range === "24h") return messages.ranges.last24h;
  if (range === "7d") return messages.ranges.last7d;
  if (range === "30d") return messages.ranges.last30d;
  if (range === "90d") return messages.ranges.last90d;
  if (range === "6m") return messages.ranges.last6m;
  if (range === "12m") return messages.ranges.last12m;
  if (range === "custom") return messages.ranges.custom;
  return messages.ranges.last30d;
}
export function intervalLabel(
  messages: AppMessages,
  interval: DashboardInterval,
): string {
  if (interval === "minute") return messages.intervals.minute;
  if (interval === "hour") return messages.intervals.hour;
  if (interval === "day") return messages.intervals.day;
  if (interval === "week") return messages.intervals.week;
  return messages.intervals.month;
}
export function toCalendarDate(
  timestampMs: number,
  timeZone: string,
): Date | null {
  if (!Number.isFinite(timestampMs)) return null;
  const parts = zonedParts(timestampMs, timeZone);
  return new Date(parts.year, parts.month - 1, parts.day);
}
export function toDateRange(
  from: number | undefined,
  to: number | undefined,
  timeZone: string,
): DateRange | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const fromDate = toCalendarDate(from as number, timeZone);
  const toDate = toCalendarDate(to as number, timeZone);
  if (!fromDate || !toDate) return undefined;
  return {
    from: fromDate,
    to: toDate,
  };
}
export function formatDateSpan(
  locale: Locale,
  timeZone: string,
  from?: number,
  to?: number,
): string {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  });
  return `${formatter.format(new Date(from as number))} - ${formatter.format(new Date(to as number))}`;
}
export function shiftTimeWindow(
  from: number,
  to: number,
  direction: "previous" | "next",
  now = Date.now(),
): { from: number; to: number } | null {
  const normalizedFrom = Math.max(0, Math.floor(from));
  const normalizedTo = Math.max(normalizedFrom + 1, Math.floor(to));
  const span = Math.max(1, normalizedTo - normalizedFrom);

  if (direction === "previous") {
    const previousTo = Math.max(normalizedFrom - 1, 0);
    const previousFrom = Math.max(previousTo - span, 0);
    if (previousFrom >= previousTo) return null;
    return {
      from: previousFrom,
      to: previousTo,
    };
  }

  const currentNow = Math.max(1, Math.floor(now));
  if (normalizedTo >= currentNow) return null;

  const nextFromCandidate = normalizedTo + 1;
  const nextToCandidate = nextFromCandidate + span;
  const nextTo = Math.min(nextToCandidate, currentNow);
  const nextFrom = Math.max(0, nextTo - span);

  if (nextFrom >= nextTo) return null;
  if (nextFrom === normalizedFrom && nextTo === normalizedTo) return null;

  return {
    from: nextFrom,
    to: nextTo,
  };
}
export const RANGE_GROUPS: ReadonlyArray<{
  key: "quick" | "calendar" | "rolling" | "advanced";
  items: ReadonlyArray<RangePreset>;
}> = [
  {
    key: "quick",
    items: ["30m", "1h", "today", "yesterday"],
  },
  {
    key: "calendar",
    items: ["thisWeek", "thisMonth", "thisYear"],
  },
  {
    key: "rolling",
    items: ["24h", "7d", "30d", "90d", "6m", "12m"],
  },
  {
    key: "advanced",
    items: ["custom"],
  },
];
export function rangeGroupLabel(
  messages: AppMessages,
  key: "quick" | "calendar" | "rolling" | "advanced",
): string {
  if (key === "quick") return messages.dashboardHeader.rangeGroupQuick;
  if (key === "calendar") return messages.dashboardHeader.rangeGroupCalendar;
  if (key === "rolling") return messages.dashboardHeader.rangeGroupRolling;
  return messages.dashboardHeader.rangeGroupAdvanced;
}
export function intervalDisabledReason(
  messages: AppMessages,
  interval: DashboardInterval,
): string {
  if (interval === "minute")
    return messages.dashboardHeader.intervalDisabledMinute;
  if (interval === "hour") return messages.dashboardHeader.intervalDisabledHour;
  if (interval === "day") return messages.dashboardHeader.intervalDisabledDay;
  if (interval === "week") return messages.dashboardHeader.intervalDisabledWeek;
  return "";
}
