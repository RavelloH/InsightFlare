import {
  addZonedInterval,
  isValidTimeZone,
  normalizeTimeZone,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";

import { FILTER_DOCUMENT_VERSION, type FilterDocument } from "./filters";
import type {
  CalendarBucket,
  CalendarBucketPlan,
  CalendarGranularity,
  EpochMs,
  QueryTime,
  ReportingTimeZone,
  TimeRange,
} from "./types";

const UTC = "UTC" as ReportingTimeZone;

function epoch(value: number): EpochMs {
  return value as EpochMs;
}

export function createTimeRange(
  startMs: number,
  endExclusiveMs: number,
): TimeRange {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs)) {
    throw new RangeError(
      "Time range boundaries must be safe integer epoch milliseconds",
    );
  }
  if (endExclusiveMs <= startMs) {
    throw new RangeError("Time range must be non-empty and half-open");
  }
  return { startMs: epoch(startMs), endExclusiveMs: epoch(endExclusiveMs) };
}

export function createQueryTime(
  startMs: number,
  endExclusiveMs: number,
  reportingTimeZone: string | null | undefined,
  capturedAtMs: number,
): QueryTime {
  if (!Number.isSafeInteger(capturedAtMs)) {
    throw new RangeError(
      "Query capture time must be a safe integer epoch millisecond",
    );
  }
  return {
    range: createTimeRange(startMs, endExclusiveMs),
    reportingTimeZone: normalizeReportingTimeZone(reportingTimeZone),
    capturedAtMs: epoch(capturedAtMs),
  };
}

export function inclusiveRangeToExclusive(
  startMs: number,
  endMs: number,
): TimeRange {
  if (!Number.isSafeInteger(endMs) || endMs === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Inclusive range end cannot be incremented safely");
  }
  return createTimeRange(startMs, endMs + 1);
}

export function exclusiveRangeToInclusive(range: TimeRange): {
  readonly startMs: number;
  readonly endMs: number;
} {
  return { startMs: range.startMs, endMs: range.endExclusiveMs - 1 };
}

export function normalizeReportingTimeZone(
  value: string | null | undefined,
  fallback = "UTC",
): ReportingTimeZone {
  const normalized = normalizeTimeZone(value);
  if (normalized) return normalized as ReportingTimeZone;
  const fallbackNormalized = normalizeTimeZone(fallback);
  return (fallbackNormalized || UTC) as ReportingTimeZone;
}

export function isReportingTimeZone(value: string): value is ReportingTimeZone {
  return isValidTimeZone(value);
}

export function previousComparableRange(range: TimeRange): TimeRange {
  const duration = range.endExclusiveMs - range.startMs;
  return createTimeRange(range.startMs - duration, range.startMs);
}

export const EMPTY_FILTER_DOCUMENT: FilterDocument = Object.freeze({
  version: FILTER_DOCUMENT_VERSION,
  root: null,
});

export function hasFilters(
  filters: FilterDocument | null | undefined,
): boolean {
  return Boolean(filters?.root);
}

export function buildCalendarBucketPlan(input: {
  readonly range: TimeRange;
  readonly granularity: CalendarGranularity;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly maxBuckets?: number;
}): CalendarBucketPlan {
  const maxBuckets = input.maxBuckets ?? 2000;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new RangeError("maxBuckets must be a positive integer");
  }
  const buckets: CalendarBucket[] = [];
  let cursor = startOfZonedInterval(
    input.range.startMs,
    input.granularity,
    input.reportingTimeZone,
  );
  let truncated = false;
  while (cursor < input.range.endExclusiveMs) {
    if (buckets.length >= maxBuckets) {
      truncated = true;
      break;
    }
    const next = addZonedInterval(
      cursor,
      input.granularity,
      input.reportingTimeZone,
    );
    if (!Number.isFinite(next) || next <= cursor) {
      throw new RangeError("Unable to advance calendar bucket");
    }
    buckets.push({
      index: buckets.length,
      startMs: epoch(cursor),
      endExclusiveMs: epoch(next),
    });
    cursor = next;
  }
  const hourAligned = buckets.every(
    (bucket) =>
      bucket.startMs % 3_600_000 === 0 &&
      bucket.endExclusiveMs % 3_600_000 === 0,
  );
  return {
    granularity: input.granularity,
    reportingTimeZone: input.reportingTimeZone,
    buckets,
    hourAligned,
    truncated,
  };
}
