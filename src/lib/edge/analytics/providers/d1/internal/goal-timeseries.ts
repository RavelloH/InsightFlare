import {
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import { queryD1All } from "./core-sources";
import {
  buildTimeBuckets,
  timeBucketCase,
  timeBucketTimestamp,
} from "./core-time";
import type { Interval, QueryWindow } from "./core-types";
import {
  compileMarkedObservationSource,
  compileScopedDatasetSql,
  scopedDatasetFor,
  type ScopedDatasetSql,
} from "./scoped-dataset";

export interface GoalTimeseriesAggregateRow {
  readonly bucket: number;
  readonly totalSessions: number;
  readonly convertedSessions: number;
  readonly totalVisitors: number;
  readonly convertedVisitors: number;
}

function baseGoalDataset(
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): ScopedDatasetSql {
  if (preparedDataset) return preparedDataset;

  const dataset = scopedDatasetFor(siteId, window, globalFilters);
  if (dataset) return dataset;
  if (globalFilters.root !== null) {
    throw new Error("scoped_dataset_required");
  }

  const plan = createScopedFilterPlan(
    "goal-timeseries",
    EMPTY_FILTER_DOCUMENT,
    "event",
  );
  if (!plan) throw new Error("goal_scope_unavailable");
  return compileScopedDatasetSql({
    filters: EMPTY_FILTER_DOCUMENT,
    plan,
    siteIds: [siteId],
    window,
  });
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Build the single-statement Goal timeseries plan.  Visit and event rows are
 * first reduced to one observation stream for the base and matched datasets.
 * Deduplicate bucketed observations once, then independently group sessions
 * and visitors by bucket and site with base/goal presence flags. This retains
 * exact identity counts without separate sets and joins for all four metrics.
 */
export async function queryGoalTimeseriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): Promise<GoalTimeseriesAggregateRow[]> {
  const dataset = baseGoalDataset(
    siteId,
    window,
    globalFilters,
    preparedDataset,
  );
  const goal = compileMarkedObservationSource(dataset, goalFilter, true);
  const buckets = buildTimeBuckets(window, interval);
  const observationBucket = timeBucketCase(buckets, "observations.observed_at");

  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `WITH
${dataset.ctes.trim()},
${goal.cte},
bucketed_observations AS MATERIALIZED (
  SELECT DISTINCT
    ${observationBucket.sql} AS bucket,
    is_goal,
    site_pk,
    session_id,
    visitor_id
  FROM source_observations AS observations
  WHERE site_pk IS NOT NULL
),
entity_counts AS (
  SELECT bucket, site_pk, session_id AS entity_id, 0 AS kind,
    1 AS is_base,
    MAX(is_goal) AS is_goal
  FROM bucketed_observations
  WHERE bucket IS NOT NULL AND TRIM(COALESCE(session_id, '')) != ''
  GROUP BY bucket, site_pk, session_id
  UNION ALL
  SELECT bucket, site_pk, visitor_id AS entity_id, 1 AS kind,
    1 AS is_base,
    MAX(is_goal) AS is_goal
  FROM bucketed_observations
  WHERE bucket IS NOT NULL AND TRIM(COALESCE(visitor_id, '')) != ''
  GROUP BY bucket, site_pk, visitor_id
),
counts AS (
  SELECT bucket,
    SUM(CASE WHEN kind = 0 THEN is_base ELSE 0 END) AS totalSessions,
    SUM(CASE WHEN kind = 0 THEN is_goal ELSE 0 END) AS convertedSessions,
    SUM(CASE WHEN kind = 1 THEN is_base ELSE 0 END) AS totalVisitors,
    SUM(CASE WHEN kind = 1 THEN is_goal ELSE 0 END) AS convertedVisitors
  FROM entity_counts
  GROUP BY bucket
)
SELECT bucket, totalSessions, convertedSessions, totalVisitors, convertedVisitors
FROM counts
WHERE totalSessions > 0 OR totalVisitors > 0
ORDER BY bucket ASC
`,
    [
      ...dataset.bindings.map((binding) => binding.value),
      ...goal.bindings.map((binding) => binding.value),
    ],
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
