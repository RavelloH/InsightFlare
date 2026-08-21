import type {
  AbsoluteTimeRangeDto,
  AnalyticsTimeRangeInputDto,
  ComparisonDatasetTimeRangeDto,
} from "@/lib/api-v1/dto/analytics";
import {
  addCalendarDays,
  addCalendarMonths,
  startOfZonedDay,
  startOfZonedMonth,
  startOfZonedWeek,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/dashboard/time-zone";

export interface ResolvedApiV1TimeRange extends AbsoluteTimeRangeDto {
  readonly timeZone: string;
}

export interface ResolvedApiV1ComparisonTimeRanges {
  readonly a: ResolvedApiV1TimeRange;
  readonly b: ResolvedApiV1TimeRange;
}

function calendarShift(timestampMs: number, timeZone: string, months: number) {
  const parts = zonedParts(timestampMs, timeZone);
  const shifted = addCalendarMonths(parts, months);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    ...shifted,
  });
}

function dayShift(timestampMs: number, timeZone: string, days: number): number {
  const parts = addCalendarDays(zonedParts(timestampMs, timeZone), days);
  return zonedTimeToUtcMs(timeZone, {
    ...parts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

/** Resolve a typed absolute/preset input using one captured clock value. */
export function resolveApiV1TimeRange(
  input: AnalyticsTimeRangeInputDto,
  capturedAtMs: number,
): ResolvedApiV1TimeRange | null {
  const timeZone = input.timeZone ?? "UTC";
  if (input.kind === "absolute") {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (
      !Number.isSafeInteger(fromMs) ||
      !Number.isSafeInteger(toMs) ||
      toMs <= fromMs
    )
      return null;
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      timeZone,
    };
  }

  const today = startOfZonedDay(capturedAtMs, timeZone);
  let from = today;
  let to = capturedAtMs;
  switch (input.preset) {
    case "today":
      break;
    case "yesterday":
      from = startOfZonedDay(today - 1, timeZone);
      to = today;
      break;
    case "last_7_days":
      from = dayShift(today, timeZone, -6);
      break;
    case "last_30_days":
      from = dayShift(today, timeZone, -29);
      break;
    case "this_week":
      from = startOfZonedWeek(capturedAtMs, timeZone);
      break;
    case "last_week":
      from = startOfZonedWeek(capturedAtMs, timeZone);
      to = from;
      from = startOfZonedWeek(dayShift(from, timeZone, -1), timeZone);
      break;
    case "this_month":
      from = startOfZonedMonth(capturedAtMs, timeZone);
      break;
    case "last_month":
      from = startOfZonedMonth(capturedAtMs, timeZone);
      to = from;
      from = startOfZonedMonth(calendarShift(from, timeZone, -1), timeZone);
      break;
  }
  if (to <= from) return null;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timeZone,
  };
}

/**
 * Resolve an explicit comparison under one top-level reporting timezone.
 * Dataset ranges omit timezone by contract, preventing mismatched calendar
 * boundaries for preset inputs.
 */
export function resolveApiV1ComparisonDatasetTimeRange(
  input: ComparisonDatasetTimeRangeDto,
  timeZone: string,
  capturedAtMs: number,
): ResolvedApiV1TimeRange | null {
  if (input.kind === "absolute") {
    return resolveApiV1TimeRange(
      { kind: "absolute", from: input.from, to: input.to, timeZone },
      capturedAtMs,
    );
  }
  return resolveApiV1TimeRange(
    { kind: "preset", preset: input.preset, timeZone },
    capturedAtMs,
  );
}

/** Derive the legacy-compatible preceding interval with identical milliseconds. */
export function resolveApiV1PreviousPeriod(
  current: ResolvedApiV1TimeRange,
): ResolvedApiV1ComparisonTimeRanges | null {
  const startMs = Date.parse(current.from);
  const endMs = Date.parse(current.to);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs))
    return null;
  const durationMs = endMs - startMs;
  const previousStartMs = startMs - durationMs;
  if (
    durationMs <= 0 ||
    !Number.isSafeInteger(previousStartMs) ||
    previousStartMs < 0
  ) {
    return null;
  }
  return {
    a: current,
    b: {
      from: new Date(previousStartMs).toISOString(),
      to: new Date(startMs).toISOString(),
      timeZone: current.timeZone,
    },
  };
}
