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

export function parseRetentionGranularity(value: string | null): Interval {
  return value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month"
    ? value
    : "week";
}

export interface RetentionResult {
  readonly granularity: Interval;
  readonly cohorts: readonly {
    readonly bucket: number;
    readonly size: number;
    readonly periods: readonly {
      readonly index: number;
      readonly visitors: number;
      readonly rate: number;
    }[];
  }[];
}

export async function queryRetentionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  granularity: Interval,
): Promise<RetentionResult> {
  const buckets = buildTimeBuckets(window, granularity);
  const bucket = timeBucketCase(buckets, "started_at");

  const filter = buildVisitFilterSql(filters);
  const filterAndClause = filter.clause
    ? filter.clause.replace(/^WHERE\s+/i, "AND ")
    : "";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    started_at,
    ${bucket.sql} AS bucket
  FROM visit_source
  WHERE visitor_id != ''
  ${filterAndClause}
),
visitor_buckets AS MATERIALIZED (
  SELECT
    visitor_id,
    bucket
  FROM filtered_visits
  WHERE bucket IS NOT NULL
  GROUP BY visitor_id, bucket
),
cohort_assign AS (
  SELECT
    visitor_id,
    MIN(bucket) AS cohort_bucket
  FROM visitor_buckets
  GROUP BY visitor_id
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
    ...visitSourceBindings(siteId, window),
    ...bucket.bindings,
    ...filter.bindings,
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
