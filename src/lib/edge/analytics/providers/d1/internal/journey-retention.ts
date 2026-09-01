import type { RetentionResult } from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type { FilterDocument, Interval, QueryWindow } from "./core";
import {
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";
import { scopedDatasetFor } from "./scoped-dataset";

export function parseRetentionGranularity(value: string | null): Interval {
  return value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month"
    ? value
    : "week";
}

export type { RetentionResult } from "@/lib/edge/analytics/contract";

export async function queryRetentionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  granularity: Interval,
): Promise<RetentionResult> {
  const buckets = buildTimeBuckets(window, granularity);
  const bucket = timeBucketCase(buckets, "started_at");

  // A prepared scoped filter already has its final visit relation. Keep the
  // legacy source/filter path intact for direct callers without scope
  // metadata; providers must not resolve or reconstruct scope membership.
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "all_visits");
  const visitRelation = scopedDataset?.visitRelation ?? "visit_source";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
all_visits AS MATERIALIZED (
  SELECT
    *,
    ${bucket.sql} AS bucket
  FROM ${visitRelation}
  WHERE visitor_id != ''
),
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    bucket
  FROM all_visits
  ${filter?.clause ?? ""}
),
cohort_assign AS (
  SELECT
    visitor_id,
    MIN(bucket) AS cohort_bucket
  FROM filtered_visits
  WHERE bucket IS NOT NULL
  GROUP BY visitor_id
),
visitor_buckets AS MATERIALIZED (
  SELECT
    av.visitor_id,
    av.bucket
  FROM all_visits av
  INNER JOIN cohort_assign ca ON ca.visitor_id = av.visitor_id
  WHERE av.bucket IS NOT NULL AND av.bucket >= ca.cohort_bucket
  GROUP BY av.visitor_id, av.bucket
)
SELECT
  cohort_bucket AS cohortBucket,
  vb.bucket AS visitBucket,
  COUNT(*) AS visitors
FROM visitor_buckets vb
JOIN cohort_assign ca ON vb.visitor_id = ca.visitor_id
GROUP BY cohort_bucket, vb.bucket
ORDER BY cohort_bucket ASC, vb.bucket ASC
`;

  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : visitSourceBindings(siteId, window)),
    ...bucket.bindings,
    ...(filter?.bindings ?? []),
  ]);

  const cohortMap = new Map<
    number,
    { size: number; periods: Map<number, number> }
  >();
  for (const row of rows) {
    const cb = Number(row.cohortBucket ?? 0);
    const vb = Number(row.visitBucket ?? 0);
    const visitors = Number(row.visitors ?? 0);

    if (!cohortMap.has(cb)) {
      cohortMap.set(cb, { size: 0, periods: new Map() });
    }
    const cohort = cohortMap.get(cb)!;
    cohort.periods.set(vb, visitors);
    if (vb === cb) cohort.size = visitors;
  }

  return {
    granularity,
    cohorts: Array.from(cohortMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([bucket, { size, periods }]) => ({
        bucket: timeBucketTimestamp(buckets, bucket),
        size,
        periods: Array.from(periods.entries())
          .sort(([a], [b]) => a - b)
          .map(([vb, visitors]) => ({
            index: Math.max(0, vb - bucket),
            visitors,
            rate: size > 0 ? visitors / size : 0,
          })),
      })),
  };
}
