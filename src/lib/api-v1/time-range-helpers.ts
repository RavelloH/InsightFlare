import { jsonError } from "@/lib/api-v1/wire-helpers";
import {
  TIME_PRESETS,
  type TimePreset,
} from "@/lib/edge/analytics/contract/catalog";

export interface TimeRange {
  /** Inclusive ISO-8601 range boundary. */
  from: string;
  /** Exclusive ISO-8601 range boundary. */
  to: string;
  timeZone: string;
}

export interface ParsedTimeRange extends TimeRange {
  startMs: number;
  endExclusiveMs: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_SET = new Set<string>(TIME_PRESETS);

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
  let startMs = today;
  let endExclusiveMs = addDays(today, 1);

  if (preset === "yesterday") {
    startMs = addDays(today, -1);
    endExclusiveMs = today;
  } else if (preset === "last_7_days") {
    startMs = addDays(today, -6);
    endExclusiveMs = addDays(today, 1);
  } else if (preset === "last_30_days") {
    startMs = addDays(today, -29);
    endExclusiveMs = addDays(today, 1);
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
    startMs = preset === "this_week" ? weekStart : addDays(weekStart, -7);
    endExclusiveMs = preset === "this_week" ? addDays(weekStart, 7) : weekStart;
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
    startMs = preset === "this_month" ? thisMonth : previousMonth;
    endExclusiveMs = preset === "this_month" ? nextMonth : thisMonth;
  }

  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endExclusiveMs).toISOString(),
    timeZone,
    startMs,
    endExclusiveMs,
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
  const endExclusiveMs = parseIsoDateTime(toRaw) ?? now.getTime();
  const startMs = parseIsoDateTime(fromRaw) ?? endExclusiveMs - 7 * ONE_DAY_MS;

  if (
    (fromRaw !== null && parseIsoDateTime(fromRaw) === null) ||
    (toRaw !== null && parseIsoDateTime(toRaw) === null) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endExclusiveMs) ||
    startMs < 0 ||
    endExclusiveMs <= startMs
  ) {
    return jsonError("validation_failed", "Invalid time range", 400, {
      fields: ["from", "to"],
    });
  }

  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endExclusiveMs).toISOString(),
    timeZone,
    startMs,
    endExclusiveMs,
  };
}

export type { TimePreset };
