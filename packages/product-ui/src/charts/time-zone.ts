import type { DashboardInterval } from "./types";

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  partsFormatters.set(timeZone, formatter);
  return formatter;
}

function zonedParts(timestampMs: number, timeZone: string): ZonedDateTimeParts {
  const date = new Date(timestampMs);
  if (timeZone === "UTC" && timestampMs >= 0 && date.getUTCFullYear() <= 9999) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      millisecond: date.getUTCMilliseconds(),
    };
  }
  const values = partsFormatter(timeZone).formatToParts(date);
  const result: ZonedDateTimeParts = {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: Math.max(0, Math.floor(timestampMs) % 1000),
  };
  for (const part of values) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === "year") result.year = value;
    else if (part.type === "month") result.month = value;
    else if (part.type === "day") result.day = value;
    else if (part.type === "hour") result.hour = value;
    else if (part.type === "minute") result.minute = value;
    else if (part.type === "second") result.second = value;
  }
  return result;
}

function offsetMinutes(timeZone: string, timestampMs: number): number {
  const parts = zonedParts(timestampMs, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return Math.round((localAsUtc - timestampMs) / 60_000);
}

function zonedTimeToUtcMs(timeZone: string, parts: ZonedDateTimeParts): number {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  if (
    timeZone === "UTC" &&
    utcGuess >= 0 &&
    new Date(utcGuess).getUTCFullYear() <= 9999
  )
    return utcGuess;
  let offset = offsetMinutes(timeZone, utcGuess);
  let result = utcGuess - offset * 60_000;
  const adjustedOffset = offsetMinutes(timeZone, result);
  if (adjustedOffset !== offset) {
    offset = adjustedOffset;
    result = utcGuess - offset * 60_000;
  }
  return result;
}

function addCalendarDays(
  parts: Pick<ZonedDateTimeParts, "year" | "month" | "day">,
  days: number,
): Pick<ZonedDateTimeParts, "year" | "month" | "day"> {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addCalendarMonths(
  parts: Pick<ZonedDateTimeParts, "year" | "month" | "day">,
  months: number,
): Pick<ZonedDateTimeParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(parts.day, lastDay) };
}

function computeStartOfZonedInterval(
  timestampMs: number,
  interval: DashboardInterval,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  if (interval === "minute") parts.second = 0;
  else if (interval === "hour") {
    parts.minute = 0;
    parts.second = 0;
  } else if (interval === "day") {
    parts.hour = 0;
    parts.minute = 0;
    parts.second = 0;
  } else if (interval === "week") {
    const dayOfWeek = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day),
    ).getUTCDay();
    const weekStart = addCalendarDays(parts, -((dayOfWeek + 6) % 7));
    parts.year = weekStart.year;
    parts.month = weekStart.month;
    parts.day = weekStart.day;
    parts.hour = 0;
    parts.minute = 0;
    parts.second = 0;
  } else {
    parts.day = 1;
    parts.hour = 0;
    parts.minute = 0;
    parts.second = 0;
  }
  parts.millisecond = 0;
  return zonedTimeToUtcMs(timeZone, parts);
}

function computeAddZonedInterval(
  timestampMs: number,
  interval: DashboardInterval,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  if (interval === "minute") parts.minute += 1;
  else if (interval === "hour") parts.hour += 1;
  else if (interval === "day") {
    Object.assign(parts, addCalendarDays(parts, 1));
  } else if (interval === "week") {
    Object.assign(parts, addCalendarDays(parts, 7));
  } else {
    Object.assign(parts, addCalendarMonths(parts, 1));
  }
  return zonedTimeToUtcMs(timeZone, parts);
}

// Multiple sparklines share the same calendar buckets. Cache only pure numeric
// results, never analytics data; bounded FIFO eviction keeps memory predictable.
const MAX_CALENDAR_CACHE_ENTRIES = 8192;
const startCache = new Map<string, number>();
const addCache = new Map<string, number>();
function cachedCalendar(
  cache: Map<string, number>,
  calculate: (
    timestamp: number,
    interval: DashboardInterval,
    zone: string,
  ) => number,
  timestamp: number,
  interval: DashboardInterval,
  zone: string,
): number {
  const key = JSON.stringify([zone, interval, timestamp]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = calculate(timestamp, interval, zone);
  if (Number.isFinite(timestamp) && Number.isFinite(value)) {
    if (cache.size >= MAX_CALENDAR_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
  return value;
}
export function startOfZonedInterval(
  timestampMs: number,
  interval: DashboardInterval,
  timeZone: string,
): number {
  return cachedCalendar(
    startCache,
    computeStartOfZonedInterval,
    timestampMs,
    interval,
    timeZone,
  );
}
export function addZonedInterval(
  timestampMs: number,
  interval: DashboardInterval,
  timeZone: string,
): number {
  return cachedCalendar(
    addCache,
    computeAddZonedInterval,
    timestampMs,
    interval,
    timeZone,
  );
}
