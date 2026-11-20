import {
  addZonedInterval,
  startOfZonedInterval,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/analytics/time-zone";
import type { FilterDurationTarget } from "@/lib/filter-contract/filters";

import type { SqlScalarTimeContext } from "./filter-sql-scalars";

export interface SqlCalendarPeriod {
  readonly start: number;
  readonly end: number;
}

function calendarStart(
  timestamp: number,
  interval: FilterDurationTarget,
  zone: string,
): number {
  const size = interval.amount;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new TypeError("Calendar interval amount must be a positive integer.");
  }
  const parts = zonedParts(timestamp, zone);
  const unit = interval.unit;
  if (unit === "mo" || unit === "y") {
    const width = size * (unit === "y" ? 12 : 1);
    const monthIndex = parts.year * 12 + parts.month - 1;
    const aligned = Math.floor(monthIndex / width) * width;
    const year = Math.floor(aligned / 12);
    const month = (aligned % 12) + 1;
    return zonedTimeToUtcMs(zone, {
      year,
      month,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  if (unit === "d" || unit === "w") {
    const dayIndex = Math.floor(
      Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000,
    );
    const weekday = (new Date(dayIndex * 86400000).getUTCDay() + 6) % 7;
    const monday = dayIndex - weekday;
    const width = size * (unit === "w" ? 7 : 1);
    const epoch = unit === "w" ? 4 : 0; // 1970-01-05 was the first epoch Monday.
    const aligned =
      Math.floor(((unit === "w" ? monday : dayIndex) - epoch) / width) * width +
      epoch;
    const date = new Date(aligned * 86400000);
    return zonedTimeToUtcMs(zone, {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  if (unit === "h") {
    if (size === 1) return startOfZonedInterval(timestamp, "hour", zone);
    const aligned = Math.floor(parts.hour / size) * size;
    return zonedTimeToUtcMs(zone, {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: aligned,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  const elapsed: Record<string, number> = { ms: 1, s: 1000, m: 60000 };
  const multiplier = elapsed[unit];
  if (multiplier === undefined)
    throw new TypeError("Unrecognized Calendar unit.");
  return Math.floor(timestamp / (multiplier * size)) * multiplier * size;
}

function calendarEnd(
  start: number,
  interval: FilterDurationTarget,
  zone: string,
): number {
  const { unit, amount } = interval;
  if (unit === "ms") return start + amount;
  if (unit === "s") return start + amount * 1000;
  if (unit === "m") return start + amount * 60000;
  if (unit === "h") return addZonedInterval(start, "hour", zone, amount);
  if (unit === "d") return addZonedInterval(start, "day", zone, amount);
  if (unit === "w") return addZonedInterval(start, "week", zone, amount);
  return addZonedInterval(
    start,
    "month",
    zone,
    amount * (unit === "y" ? 12 : 1),
  );
}

/**
 * Prepare natural IANA calendar boundaries; SQL still joins and filters
 * every event/visit. The list is not an artificial data-read budget.
 */
export function sqlCalendarPeriods(
  interval: FilterDurationTarget,
  clock: SqlScalarTimeContext,
): readonly SqlCalendarPeriod[] {
  if (
    !Number.isFinite(clock.rangeStartMs) ||
    !Number.isFinite(clock.rangeEndExclusiveMs) ||
    clock.rangeStartMs >= clock.rangeEndExclusiveMs
  )
    return [];
  let current = calendarStart(clock.rangeStartMs, interval, clock.timeZone);
  const periods: SqlCalendarPeriod[] = [];
  while (current < clock.rangeEndExclusiveMs) {
    const end = calendarEnd(current, interval, clock.timeZone);
    if (!Number.isFinite(end) || end <= current) {
      throw new TypeError("Calendar interval did not advance.");
    }
    periods.push({ start: current, end });
    current = end;
  }
  return periods;
}
