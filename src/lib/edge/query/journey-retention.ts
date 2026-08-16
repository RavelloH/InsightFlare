import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  jsonResponseWith,
  parseFilters,
  parseWindow,
  queryD1All,
  type ResponseContext,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";

export async function handleRetention(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const rawGranularity =
    url.searchParams.get("granularity") ||
    url.searchParams.get("interval") ||
    "week";
  const granularity =
    rawGranularity === "minute" ||
    rawGranularity === "hour" ||
    rawGranularity === "day" ||
    rawGranularity === "week" ||
    rawGranularity === "month"
      ? rawGranularity
      : "week";

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
cohort_assign AS (
  SELECT
    visitor_id,
    MIN(bucket) AS cohort_bucket
  FROM filtered_visits
  WHERE bucket IS NOT NULL
  GROUP BY visitor_id
),
return_data AS (
  SELECT
    ca.cohort_bucket,
    fv.bucket AS visit_bucket,
    fv.visitor_id
  FROM filtered_visits fv
  JOIN cohort_assign ca ON fv.visitor_id = ca.visitor_id
  WHERE fv.bucket IS NOT NULL
)
SELECT
  cohort_bucket AS cohortBucket,
  visit_bucket AS visitBucket,
  COUNT(DISTINCT visitor_id) AS visitors
FROM return_data
GROUP BY cohort_bucket, visit_bucket
ORDER BY cohort_bucket ASC, visit_bucket ASC
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
    if (vb === cb) {
      cohort.size = visitors;
    }
  }

  const cohorts = Array.from(cohortMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, { size, periods }]) => ({
      bucket: timeBucketTimestamp(buckets, bucket),
      size,
      periods: Array.from(periods.entries())
        .sort(([a], [b]) => a - b)
        .map(([vb, visitors]) => {
          const index = Math.max(0, vb - bucket);
          return {
            index,
            visitors,
            rate: size > 0 ? visitors / size : 0,
          };
        }),
    }));

  return jsonResponseWith(ctx!, { ok: true, granularity, cohorts });
}
