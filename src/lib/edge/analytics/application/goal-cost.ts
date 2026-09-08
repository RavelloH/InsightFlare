import type { QueryCostInput } from "@/lib/edge/analytics/application/cost";
import {
  buildCalendarBucketPlan,
  createTimeRange,
  filterConditionCount,
  type FilterDocument,
  normalizeReportingTimeZone,
} from "@/lib/edge/analytics/contract";

export const GOAL_TIMESERIES_MAX_BUCKETS = 512;

export type GoalInterval = "minute" | "hour" | "day" | "week" | "month";

export interface GoalQueryCostInput {
  readonly filters: FilterDocument;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly interval?: GoalInterval;
  /** A caller may provide an exact persisted-DSL complexity estimate. */
  readonly goalFilterComplexity?: number;
}

function bucketCount(input: GoalQueryCostInput): number {
  if (!input.interval) return 1;
  try {
    const plan = buildCalendarBucketPlan({
      range: createTimeRange(input.startMs, input.endExclusiveMs),
      granularity: input.interval,
      reportingTimeZone: normalizeReportingTimeZone(input.timeZone),
      maxBuckets: GOAL_TIMESERIES_MAX_BUCKETS,
    });
    return plan.truncated
      ? GOAL_TIMESERIES_MAX_BUCKETS + 1
      : Math.max(1, plan.buckets.length);
  } catch {
    // Invalid or unbounded bucket plans fail closed in the shared cost gate.
    return GOAL_TIMESERIES_MAX_BUCKETS + 1;
  }
}

/**
 * Goal analytics has two independent matcher layers: the dashboard/API
 * filter and the persisted Goal DSL. The latter is conservative until the
 * provider loads and validates the stored definition, so complex definitions
 * can never be treated as a free query.
 */
export function goalQueryCost(input: GoalQueryCostInput): QueryCostInput {
  return {
    rangeMs: input.endExclusiveMs - input.startMs,
    siteCount: 1,
    metricCount: 2,
    bucketCount: bucketCount(input),
    filterComplexity: Math.max(1, filterConditionCount(input.filters)),
    goalFilterComplexity: Math.max(1, input.goalFilterComplexity ?? 4),
    projectionFields: 4,
    provider: "d1",
    requiresRawSource: true,
    batchFanout: 1,
  };
}
