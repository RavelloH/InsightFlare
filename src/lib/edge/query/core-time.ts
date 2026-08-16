import {
  addCalendarDays,
  addCalendarMonths,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/dashboard/time-zone";
import { ONE_DAY_MS, ONE_HOUR_MS } from "@/lib/edge/utils";

import { type Interval, type QueryWindow } from "./core-types";

export function appendSqlConditions(
  baseClause: string,
  conditions: string[],
): string {
  const normalizedConditions = conditions
    .map((condition) => condition.trim())
    .filter((condition) => condition.length > 0);
  if (normalizedConditions.length === 0) return baseClause;
  if (baseClause.trim().length > 0) {
    return `${baseClause} AND ${normalizedConditions.join(" AND ")}`;
  }
  return `WHERE ${normalizedConditions.join(" AND ")}`;
}

export function sourceLabel(_window: QueryWindow): "detail" {
  return "detail";
}

export function avgDuration(totalDuration: number, sessions: number): number {
  if (sessions <= 0) return 0;
  return Math.round(totalDuration / sessions);
}

export function bounceRate(bounces: number, sessions: number): number {
  if (sessions <= 0) return 0;
  return Number((bounces / sessions).toFixed(6));
}

export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0)
    return null;
  return ((current - previous) / previous) * 100;
}

export function intervalBucketMs(interval: Interval): number {
  if (interval === "minute") return 60_000;
  if (interval === "hour") return ONE_HOUR_MS;
  if (interval === "day") return ONE_DAY_MS;
  if (interval === "week") return 7 * ONE_DAY_MS;
  return 30 * ONE_DAY_MS;
}

export interface TimeBucket {
  index: number;
  timestampMs: number;
  fromMs: number;
  toMs: number;
}

export interface TimeBucketCase {
  sql: string;
  bindings: number[];
}

export function sqlIntegerLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Invalid time bucket boundary");
  }
  return String(Math.trunc(value));
}

function startOfIntervalParts(
  timestampMs: number,
  interval: Interval,
  timeZone: string,
) {
  const parts = zonedParts(timestampMs, timeZone);
  if (interval === "minute") {
    return { ...parts, second: 0, millisecond: 0 };
  }
  if (interval === "hour") {
    return { ...parts, minute: 0, second: 0, millisecond: 0 };
  }
  if (interval === "day") {
    return { ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 };
  }
  if (interval === "week") {
    const dayOfWeek = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day),
    ).getUTCDay();
    const mondayOffset = (dayOfWeek + 6) % 7;
    const weekStart = addCalendarDays(parts, -mondayOffset);
    return {
      ...parts,
      ...weekStart,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    };
  }
  return {
    ...parts,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function advanceIntervalParts(
  parts: ReturnType<typeof zonedParts>,
  interval: Interval,
) {
  if (interval === "minute") return { ...parts, minute: parts.minute + 1 };
  if (interval === "hour") return { ...parts, hour: parts.hour + 1 };
  if (interval === "day") return { ...parts, ...addCalendarDays(parts, 1) };
  if (interval === "week") return { ...parts, ...addCalendarDays(parts, 7) };
  return { ...parts, ...addCalendarMonths(parts, 1) };
}

export function buildTimeBuckets(
  window: QueryWindow,
  interval: Interval,
): TimeBucket[] {
  const buckets: TimeBucket[] = [];
  let currentParts = startOfIntervalParts(
    window.fromMs,
    interval,
    window.timeZone,
  );
  let current = zonedTimeToUtcMs(window.timeZone, currentParts);
  const hardLimit = 2000;

  for (let index = 0; index < hardLimit && current <= window.toMs; index += 1) {
    const nextParts = advanceIntervalParts(currentParts, interval);
    let next = zonedTimeToUtcMs(window.timeZone, nextParts);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalBucketMs(interval);
      currentParts = zonedParts(next, window.timeZone);
    } else {
      currentParts = nextParts;
    }
    buckets.push({
      index,
      timestampMs: current,
      fromMs: current,
      toMs: next,
    });
    current = next;
  }

  if (buckets.length === 0) {
    const fallbackStart = Math.max(0, Math.floor(window.fromMs));
    buckets.push({
      index: 0,
      timestampMs: fallbackStart,
      fromMs: fallbackStart,
      toMs: Math.max(fallbackStart + 1, Math.floor(window.toMs) + 1),
    });
  }

  return buckets;
}

export function timeBucketCase(
  buckets: TimeBucket[],
  columnExpression: string,
): TimeBucketCase {
  const clauses = buckets.map((bucket) => {
    return `WHEN ${columnExpression} >= ${sqlIntegerLiteral(bucket.fromMs)} AND ${columnExpression} < ${sqlIntegerLiteral(bucket.toMs)} THEN ${bucket.index}`;
  });
  return {
    sql: `CASE ${clauses.join(" ")} ELSE NULL END`,
    bindings: [],
  };
}

export function timeBucketTimestamp(
  buckets: TimeBucket[],
  bucketIndex: number,
): number {
  return buckets[bucketIndex]?.timestampMs ?? 0;
}
