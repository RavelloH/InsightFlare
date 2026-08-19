export const FALLBACK_TIME_ZONE = "UTC";
export const REPORTING_TIME_ZONE_COOKIE = "insightflare-reporting-time-zone";

const REPORTING_TIME_ZONE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const COMMON_TIME_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Seoul",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Australia/Sydney",
] as const;

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeZoneNameFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeZoneValidityCache = new Map<string, boolean>();
const MAX_TIME_ZONE_VALIDITY_CACHE_ENTRIES = 128;

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export type ZonedInterval = "minute" | "hour" | "day" | "week" | "month";

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
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
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(value: string): boolean {
  const timeZone = value.trim();
  if (!timeZone) return false;
  if (timeZone.length > 128) return false;
  const cached = timeZoneValidityCache.get(timeZone);
  if (cached !== undefined) return cached;

  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    valid = true;
  } catch {
    valid = false;
  }
  if (timeZoneValidityCache.size >= MAX_TIME_ZONE_VALIDITY_CACHE_ENTRIES) {
    timeZoneValidityCache.clear();
  }
  timeZoneValidityCache.set(timeZone, valid);
  return valid;
}

export function normalizeTimeZone(value: string | null | undefined): string {
  const timeZone = String(value ?? "").trim();
  return isValidTimeZone(timeZone) ? timeZone : "";
}

export function resolveReportingTimeZone(
  preferredTimeZone: string | null | undefined,
  browserTimeZone?: string | null,
): string {
  return (
    normalizeTimeZone(preferredTimeZone) ||
    normalizeTimeZone(browserTimeZone) ||
    FALLBACK_TIME_ZONE
  );
}

export function browserTimeZone(): string {
  try {
    return normalizeTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    );
  } catch {
    return "";
  }
}

/** Persists the effective reporting time zone without causing a navigation. */
export function writeReportingTimeZoneCookie(timeZone: string): void {
  if (typeof document === "undefined") return;
  const resolved = normalizeTimeZone(timeZone);
  if (!resolved) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${REPORTING_TIME_ZONE_COOKIE}=${encodeURIComponent(resolved)}; Path=/; Max-Age=${REPORTING_TIME_ZONE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

export function supportedTimeZones(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supported =
    typeof intlWithSupportedValues.supportedValuesOf === "function"
      ? intlWithSupportedValues.supportedValuesOf("timeZone")
      : [];
  return Array.from(new Set([...COMMON_TIME_ZONES, ...supported])).sort(
    (left, right) => left.localeCompare(right),
  );
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function getTimeZoneNameFormatter(
  locale: string,
  timeZone: string,
): Intl.DateTimeFormat | null {
  const cacheKey = `${locale}::${timeZone}`;
  const cached = timeZoneNameFormatterCache.get(cacheKey);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      timeZoneName: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeZoneNameFormatterCache.set(cacheKey, formatter);
    return formatter;
  } catch {
    return null;
  }
}

export function formatTimeZoneOptionLabel(input: {
  locale: string;
  timeZone: string;
  timestampMs: number;
}): string {
  const date = new Date(input.timestampMs);
  const name =
    getTimeZoneNameFormatter(input.locale, input.timeZone)
      ?.formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim() || "";
  const offset = formatUtcOffset(
    timeZoneOffsetMinutes(input.timeZone, input.timestampMs),
  );
  return name && name !== input.timeZone
    ? `${name} (${offset}) - ${input.timeZone}`
    : `${input.timeZone} (${offset})`;
}

export function buildTimeZoneOptions(input: {
  locale: string;
  supported?: string[];
  selected?: string;
  active?: string;
  browser?: string;
  timestampMs: number;
}): Array<{ value: string; label: string }> {
  const values = new Set<string>();
  for (const value of [
    input.selected,
    input.active,
    input.browser,
    ...(input.supported ?? supportedTimeZones()),
  ]) {
    const normalized = normalizeTimeZone(value);
    if (normalized) values.add(normalized);
  }

  return Array.from(values).map((value) => ({
    value,
    label: formatTimeZoneOptionLabel({
      locale: input.locale,
      timeZone: value,
      timestampMs: input.timestampMs,
    }),
  }));
}

export function zonedParts(
  timestampMs: number,
  timeZone: string,
): ZonedDateTimeParts {
  const date = new Date(timestampMs);
  const parts = getPartsFormatter(
    resolveReportingTimeZone(timeZone),
  ).formatToParts(date);
  const result: ZonedDateTimeParts = {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: Math.max(0, Math.floor(timestampMs) % 1000),
  };

  for (const part of parts) {
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

export function timeZoneOffsetMinutes(
  timeZone: string,
  timestampMs: number,
): number {
  const resolved = resolveReportingTimeZone(timeZone);
  const parts = zonedParts(timestampMs, resolved);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return Math.round((asUtc - timestampMs) / 60000);
}

export function zonedTimeToUtcMs(
  timeZone: string,
  parts: ZonedDateTimeParts,
): number {
  const resolved = resolveReportingTimeZone(timeZone);
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let offset = timeZoneOffsetMinutes(resolved, utcGuess);
  let result = utcGuess - offset * 60_000;
  const nextOffset = timeZoneOffsetMinutes(resolved, result);
  if (nextOffset !== offset) {
    offset = nextOffset;
    result = utcGuess - offset * 60_000;
  }
  return result;
}

export function addCalendarDays(
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

export function addCalendarMonths(
  parts: Pick<ZonedDateTimeParts, "year" | "month" | "day">,
  months: number,
): Pick<ZonedDateTimeParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const targetYear = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return {
    year: targetYear,
    month: targetMonth,
    day: Math.min(parts.day, lastDay),
  };
}

export function startOfZonedDay(timestampMs: number, timeZone: string): number {
  const parts = zonedParts(timestampMs, timeZone);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function startOfZonedMinute(
  timestampMs: number,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    second: 0,
    millisecond: 0,
  });
}

export function startOfZonedHour(
  timestampMs: number,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function endOfZonedDay(timestampMs: number, timeZone: string): number {
  const parts = zonedParts(timestampMs, timeZone);
  const nextDay = addCalendarDays(parts, 1);
  return (
    zonedTimeToUtcMs(timeZone, {
      year: nextDay.year,
      month: nextDay.month,
      day: nextDay.day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    }) - 1
  );
}

export function startOfZonedWeek(
  timestampMs: number,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  const dayOfWeek = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  const weekStart = addCalendarDays(parts, -mondayOffset);
  return zonedTimeToUtcMs(timeZone, {
    year: weekStart.year,
    month: weekStart.month,
    day: weekStart.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function startOfZonedMonth(
  timestampMs: number,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  return zonedTimeToUtcMs(timeZone, {
    year: parts.year,
    month: parts.month,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function startOfZonedInterval(
  timestampMs: number,
  interval: ZonedInterval,
  timeZone: string,
): number {
  if (interval === "minute") return startOfZonedMinute(timestampMs, timeZone);
  if (interval === "hour") return startOfZonedHour(timestampMs, timeZone);
  if (interval === "day") return startOfZonedDay(timestampMs, timeZone);
  if (interval === "week") return startOfZonedWeek(timestampMs, timeZone);
  return startOfZonedMonth(timestampMs, timeZone);
}

export function addZonedInterval(
  timestampMs: number,
  interval: ZonedInterval,
  timeZone: string,
  amount = 1,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  if (interval === "minute") {
    return zonedTimeToUtcMs(timeZone, {
      ...parts,
      minute: parts.minute + amount,
    });
  }
  if (interval === "hour") {
    return zonedTimeToUtcMs(timeZone, {
      ...parts,
      hour: parts.hour + amount,
    });
  }
  if (interval === "day") {
    const next = addCalendarDays(parts, amount);
    return zonedTimeToUtcMs(timeZone, {
      ...parts,
      year: next.year,
      month: next.month,
      day: next.day,
    });
  }
  if (interval === "week") {
    const next = addCalendarDays(parts, amount * 7);
    return zonedTimeToUtcMs(timeZone, {
      ...parts,
      year: next.year,
      month: next.month,
      day: next.day,
    });
  }
  const next = addCalendarMonths(parts, amount);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    year: next.year,
    month: next.month,
    day: next.day,
  });
}

export function startOfZonedYear(
  timestampMs: number,
  timeZone: string,
): number {
  const parts = zonedParts(timestampMs, timeZone);
  return zonedTimeToUtcMs(timeZone, {
    year: parts.year,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}
