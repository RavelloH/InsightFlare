import {
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type ScopedDatasetSql,
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
  compileScopedDatasetSql,
  executeObservationFilterOnScopedDataset,
  scopedDatasetFor,
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
 * Session and visitor identities are then independently deduplicated by
 * bucket/site in SQL, so an identity can count once in every bucket while
 * still being counted only once inside a bucket.
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
  const goal = executeObservationFilterOnScopedDataset(
    dataset,
    goalFilter,
    "goal",
  );
  const buckets = buildTimeBuckets(window, interval);
  const visitBucket = timeBucketCase(buckets, "started_at");
  const eventBucket = timeBucketCase(buckets, "occurred_at");

  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `WITH
${dataset.ctes.trim()},
${goal.ctes.trim()},
base_bucket_observations AS MATERIALIZED (
  SELECT
    ${visitBucket.sql} AS bucket,
    site_pk,
    session_id,
    visitor_id
  FROM ${dataset.visitRelation}
  WHERE site_pk IS NOT NULL
    AND ${visitBucket.sql} IS NOT NULL
  UNION
  SELECT
    ${eventBucket.sql} AS bucket,
    site_pk,
    session_id,
    visitor_id
  FROM ${dataset.eventRelation}
  WHERE site_pk IS NOT NULL
    AND ${eventBucket.sql} IS NOT NULL
),
goal_bucket_observations AS MATERIALIZED (
  SELECT
    ${visitBucket.sql} AS bucket,
    site_pk,
    session_id,
    visitor_id
  FROM ${goal.matchedVisitRelation}
  WHERE site_pk IS NOT NULL
    AND ${visitBucket.sql} IS NOT NULL
  UNION
  SELECT
    ${eventBucket.sql} AS bucket,
    site_pk,
    session_id,
    visitor_id
  FROM ${goal.matchedEventRelation}
  WHERE site_pk IS NOT NULL
    AND ${eventBucket.sql} IS NOT NULL
),
base_bucket_sessions AS (
  SELECT DISTINCT bucket, site_pk, session_id
  FROM base_bucket_observations
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
base_bucket_visitors AS (
  SELECT DISTINCT bucket, site_pk, visitor_id
  FROM base_bucket_observations
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
),
goal_bucket_sessions AS (
  SELECT DISTINCT bucket, site_pk, session_id
  FROM goal_bucket_observations
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
goal_bucket_visitors AS (
  SELECT DISTINCT bucket, site_pk, visitor_id
  FROM goal_bucket_observations
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
),
base_session_counts AS (
  SELECT bucket, COUNT(*) AS totalSessions
  FROM base_bucket_sessions
  GROUP BY bucket
),
base_visitor_counts AS (
  SELECT bucket, COUNT(*) AS totalVisitors
  FROM base_bucket_visitors
  GROUP BY bucket
),
base_counts AS (
  SELECT
    buckets.bucket,
    COALESCE(sessions.totalSessions, 0) AS totalSessions,
    COALESCE(visitors.totalVisitors, 0) AS totalVisitors
  FROM (
    SELECT bucket FROM base_bucket_sessions
    UNION
    SELECT bucket FROM base_bucket_visitors
  ) buckets
  LEFT JOIN base_session_counts sessions ON sessions.bucket = buckets.bucket
  LEFT JOIN base_visitor_counts visitors ON visitors.bucket = buckets.bucket
),
goal_session_counts AS (
  SELECT bucket, COUNT(*) AS convertedSessions
  FROM goal_bucket_sessions
  GROUP BY bucket
),
goal_visitor_counts AS (
  SELECT bucket, COUNT(*) AS convertedVisitors
  FROM goal_bucket_visitors
  GROUP BY bucket
),
goal_counts AS (
  SELECT
    buckets.bucket,
    COALESCE(sessions.convertedSessions, 0) AS convertedSessions,
    COALESCE(visitors.convertedVisitors, 0) AS convertedVisitors
  FROM (
    SELECT bucket FROM goal_bucket_sessions
    UNION
    SELECT bucket FROM goal_bucket_visitors
  ) buckets
  LEFT JOIN goal_session_counts sessions ON sessions.bucket = buckets.bucket
  LEFT JOIN goal_visitor_counts visitors ON visitors.bucket = buckets.bucket
)
SELECT
  base.bucket,
  base.totalSessions,
  COALESCE(goal.convertedSessions, 0) AS convertedSessions,
  base.totalVisitors,
  COALESCE(goal.convertedVisitors, 0) AS convertedVisitors
FROM base_counts base
LEFT JOIN goal_counts goal ON goal.bucket = base.bucket
ORDER BY base.bucket ASC
`,
    [
      ...dataset.bindings.map((binding) => binding.value),
      ...goal.bindings.map((binding) => binding.value),
      ...visitBucket.bindings,
      ...eventBucket.bindings,
      ...visitBucket.bindings,
      ...eventBucket.bindings,
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
