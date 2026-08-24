import {
  buildCalendarBucketPlan,
  createTimeRange,
  normalizeReportingTimeZone,
  previousComparableRange,
} from "@/lib/edge/analytics/contract";
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
  startMs: number;
  endExclusiveMs: number;
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

export function buildTimeBuckets(
  window: QueryWindow,
  interval: Interval,
): TimeBucket[] {
  const plan = buildCalendarBucketPlan({
    range: createTimeRange(window.startMs, window.endExclusiveMs),
    granularity: interval,
    reportingTimeZone: normalizeReportingTimeZone(window.timeZone),
  });
  return plan.buckets.map((bucket) => ({
    index: bucket.index,
    timestampMs: bucket.startMs,
    startMs: bucket.startMs,
    endExclusiveMs: bucket.endExclusiveMs,
  }));
}

export function previousComparableWindow(window: QueryWindow): QueryWindow {
  const range = previousComparableRange(
    createTimeRange(window.startMs, window.endExclusiveMs),
  );
  return {
    startMs: range.startMs,
    endExclusiveMs: range.endExclusiveMs,
    nowMs: window.nowMs,
    timeZone: window.timeZone,
  };
}

export function timeBucketCase(
  buckets: TimeBucket[],
  columnExpression: string,
): TimeBucketCase {
  const clauses = buckets.map((bucket) => {
    return `WHEN ${columnExpression} >= ${sqlIntegerLiteral(bucket.startMs)} AND ${columnExpression} < ${sqlIntegerLiteral(bucket.endExclusiveMs)} THEN ${bucket.index}`;
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
