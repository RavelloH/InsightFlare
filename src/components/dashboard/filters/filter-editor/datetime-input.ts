import {
  resolveReportingTimeZone,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/analytics/time-zone";

function resolvedTimeZone(timeZone: string | undefined): string {
  return resolveReportingTimeZone(timeZone);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function dateTimeLiteralToInputValue(
  value: unknown,
  timeZone: string | undefined,
): string {
  if (typeof value !== "string") return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return value;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  const parts = zonedParts(timestamp, resolvedTimeZone(timeZone));
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function dateTimeInputValueToLiteral(
  value: string,
  timeZone: string | undefined,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;

  const timestamp = zonedTimeToUtcMs(resolvedTimeZone(timeZone), {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
    millisecond: 0,
  });
  return new Date(timestamp).toISOString();
}

export function dateTimeLiteralAtLocalDayStart(
  timeZone: string | undefined,
  dayOffset = 0,
  now = Date.now(),
): string {
  const parts = zonedParts(now, resolvedTimeZone(timeZone));
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset),
  );
  const localMidnight = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T00:00`;
  return dateTimeInputValueToLiteral(localMidnight, timeZone);
}
