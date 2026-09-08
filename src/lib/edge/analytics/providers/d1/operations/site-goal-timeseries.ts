import type { GoalDefinition } from "@/lib/edge/analytics/contract";
import {
  type FilterDocument,
  parseGoalFilter,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import { buildTimeBuckets } from "@/lib/edge/analytics/providers/d1/internal/core-time";
import type {
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";
import type { GoalTimeseriesAggregateRow } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import { queryGoalTimeseriesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import { queryGoalDefinition } from "@/lib/edge/analytics/providers/d1/internal/goals";
import type { Env } from "@/lib/edge/types";

export interface SiteGoalTimeseriesInput {
  readonly env: Env;
  readonly siteId: string;
  readonly goalId: string;
  readonly interval: Interval;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly scopedDataset?: ScopedDatasetSql;
}

export interface SiteGoalTimeseriesPoint {
  readonly timestampMs: number;
  readonly sessions: {
    readonly total: number;
    readonly converted: number;
    readonly conversionRate: number;
  };
  readonly visitors: {
    readonly total: number;
    readonly converted: number;
    readonly conversionRate: number;
  };
}

export interface SiteGoalTimeseriesResult {
  readonly goal: GoalDefinition;
  readonly interval: Interval;
  readonly timeseries: readonly SiteGoalTimeseriesPoint[];
}

function metric(total: number, converted: number) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safeConverted = Math.min(
    safeTotal,
    Number.isFinite(converted) && converted > 0 ? Math.floor(converted) : 0,
  );
  return {
    total: safeTotal,
    converted: safeConverted,
    conversionRate: safeTotal > 0 ? safeConverted / safeTotal : 0,
  };
}

/** Runtime provider boundary for the typed Goal timeseries operation. */
export async function readSiteGoalTimeseries(
  input: SiteGoalTimeseriesInput,
): Promise<SiteGoalTimeseriesResult | null> {
  const goal = await queryGoalDefinition(input.env, input.siteId, input.goalId);
  if (!goal) return null;
  const rows = await queryGoalTimeseriesFromD1(
    input.env,
    input.siteId,
    input.window,
    input.interval,
    input.filters,
    parseGoalFilter(goal),
    input.scopedDataset,
  );
  const rowsByBucket = new Map<number, GoalTimeseriesAggregateRow>(
    rows.map((row) => [row.bucket, row]),
  );
  const timeseries = buildTimeBuckets(input.window, input.interval).map(
    (bucket) => {
      const row = rowsByBucket.get(bucket.index);
      return {
        timestampMs: bucket.timestampMs,
        sessions: metric(row?.totalSessions ?? 0, row?.convertedSessions ?? 0),
        visitors: metric(row?.totalVisitors ?? 0, row?.convertedVisitors ?? 0),
      };
    },
  );
  return { goal, interval: input.interval, timeseries };
}
