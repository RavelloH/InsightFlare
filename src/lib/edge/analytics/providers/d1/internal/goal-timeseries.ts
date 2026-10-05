import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  buildGoalTimeseriesReportPlan,
  GOAL_TIMESERIES_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/goal-observation-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import { buildTimeBuckets, timeBucketTimestamp } from "./core-time";
import type { Interval, QueryWindow } from "./core-types";

export interface GoalTimeseriesAggregateRow {
  readonly bucket: number;
  readonly totalSessions: number;
  readonly convertedSessions: number;
  readonly totalVisitors: number;
  readonly convertedVisitors: number;
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Execute Goal timeseries through one typed logical report output. */
export async function queryGoalTimeseriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
): Promise<GoalTimeseriesAggregateRow[]> {
  const plan = buildGoalTimeseriesReportPlan({
    siteId,
    window,
    interval,
    filters: globalFilters,
    goalFilter,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    GOAL_TIMESERIES_REPORT_OUTPUT,
  );
  const rowByBucket = new Map(
    rows.map((row) => [
      Number(row.bucket ?? -1),
      {
        bucket: Number(row.bucket ?? -1),
        totalSessions: countValue(row.totalSessions),
        convertedSessions: countValue(row.convertedSessions),
        totalVisitors: countValue(row.totalVisitors),
        convertedVisitors: countValue(row.convertedVisitors),
      },
    ]),
  );
  const buckets = buildTimeBuckets(window, interval);
  return buckets.map(
    (bucket) =>
      rowByBucket.get(bucket.index) ?? {
        bucket: bucket.index,
        totalSessions: 0,
        convertedSessions: 0,
        totalVisitors: 0,
        convertedVisitors: 0,
      },
  );
}

/** Resolve a sparse SQL result to bucket timestamps for low-level consumers. */
export function withGoalTimeseriesTimestamps(
  rows: readonly GoalTimeseriesAggregateRow[],
  window: QueryWindow,
  interval: Interval,
) {
  const buckets = buildTimeBuckets(window, interval);
  return rows.map((row) => ({
    ...row,
    timestampMs: timeBucketTimestamp(buckets, row.bucket),
  }));
}

/** Short alias for callers that use the operation name without the D1 suffix. */
export const queryGoalTimeseries = queryGoalTimeseriesFromD1;
