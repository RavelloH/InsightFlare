import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  Interval,
  PerformanceCountryRow,
  PerformanceMetricKey,
  PerformanceRouteRow,
  PerformanceSummaryRow,
  PerformanceTrendPointRow,
  QueryWindow,
} from "./core";
import {
  appendSqlConditions,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  emptyPerformanceRouteMetrics,
  normalizePathname,
  PERFORMANCE_METRIC_COLUMNS,
  PERFORMANCE_METRIC_KEYS,
  performanceMetricColumn,
  queryD1All,
  roundPerformanceValue,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";
import { scopedDatasetFor } from "./scoped-dataset";

interface PerformanceVisitSource {
  readonly ctes: string;
  readonly relation: string;
  readonly bindings: Array<string | number | null>;
  readonly filterClause: string;
  readonly filterBindings: Array<string | number>;
}

function performanceVisitSource(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): PerformanceVisitSource {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  if (scopedDataset) {
    return {
      ctes: scopedDataset.ctes,
      relation: scopedDataset.visitRelation,
      bindings: scopedDataset.bindings.map(({ value }) => value),
      filterClause: "",
      filterBindings: [],
    };
  }

  const filter = buildVisitFilterSql(filters);
  return {
    ctes: buildVisitSourceCte(),
    relation: "visit_source",
    bindings: visitSourceBindings(siteId, window),
    filterClause: filter.clause,
    filterBindings: filter.bindings,
  };
}

function performanceMetricVisitsSql(
  source: string,
  dimensions: string[] = [],
): string {
  const dimensionSql =
    dimensions.length > 0 ? `${dimensions.join(", ")}, ` : "";
  return PERFORMANCE_METRIC_KEYS.map((metric) => {
    const column = PERFORMANCE_METRIC_COLUMNS[metric];
    return `SELECT ${dimensionSql}'${metric}' AS metric, ${column} AS metricValue
  FROM ${source}
  WHERE ${column} IS NOT NULL`;
  }).join("\n  UNION ALL\n  ");
}

function performanceMetricPresenceSql(): string {
  return PERFORMANCE_METRIC_KEYS.map(
    (metric) => `${PERFORMANCE_METRIC_COLUMNS[metric]} IS NOT NULL`,
  ).join(" OR ");
}

function emptyPerformanceSummaries(): Record<
  PerformanceMetricKey,
  PerformanceSummaryRow
> {
  return {
    ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
  };
}

function mapPerformanceSummaries(
  rows: Record<string, unknown>[],
): Record<PerformanceMetricKey, PerformanceSummaryRow> {
  const summaries = emptyPerformanceSummaries();
  for (const row of rows) {
    const metric = String(row.metric ?? "") as PerformanceMetricKey;
    if (!(metric in PERFORMANCE_METRIC_COLUMNS)) continue;
    summaries[metric] = {
      avg: roundPerformanceValue(row.avgValue),
      p50: roundPerformanceValue(row.p50),
      p75: roundPerformanceValue(row.p75),
      p95: roundPerformanceValue(row.p95),
      samples: Number(row.samples ?? 0),
    };
  }
  return summaries;
}

function emptyPerformanceTrends(): Record<
  PerformanceMetricKey,
  PerformanceTrendPointRow[]
> {
  return { ttfb: [], fcp: [], lcp: [], cls: [], inp: [] };
}

function mapPerformanceTrends(
  rows: Record<string, unknown>[],
  buckets: ReturnType<typeof buildTimeBuckets>,
): Record<PerformanceMetricKey, PerformanceTrendPointRow[]> {
  const trends = emptyPerformanceTrends();
  for (const row of rows) {
    const metric = String(row.metric ?? "") as PerformanceMetricKey;
    if (!(metric in PERFORMANCE_METRIC_COLUMNS)) continue;
    const bucketIndex = Number(row.bucket ?? 0);
    trends[metric].push({
      bucket: bucketIndex,
      timestampMs: timeBucketTimestamp(buckets, bucketIndex),
      avg: roundPerformanceValue(row.avgValue),
      p50: roundPerformanceValue(row.p50),
      p75: roundPerformanceValue(row.p75),
      p95: roundPerformanceValue(row.p95),
      samples: Number(row.samples ?? 0),
    });
  }
  return trends;
}

function mapPerformanceRoutes(
  rows: Record<string, unknown>[],
): PerformanceRouteRow[] {
  const byPath = new Map<string, PerformanceRouteRow>();
  for (const row of rows) {
    const pathname = normalizePathname(String(row.pathname ?? ""));
    const metric = String(row.metric ?? "") as PerformanceMetricKey;
    if (!(metric in PERFORMANCE_METRIC_COLUMNS)) continue;
    const current = byPath.get(pathname) ?? {
      pathname,
      views: Number(row.views ?? 0),
      metrics: emptyPerformanceRouteMetrics(),
    };
    current.metrics[metric] = {
      avg: roundPerformanceValue(row.avgValue),
      p50: roundPerformanceValue(row.p50),
      p75: roundPerformanceValue(row.p75),
      p95: roundPerformanceValue(row.p95),
      samples: Number(row.samples ?? 0),
    };
    byPath.set(pathname, current);
  }
  return [...byPath.values()];
}

function mapPerformanceCountries(
  rows: Record<string, unknown>[],
): PerformanceCountryRow[] {
  const byCountry = new Map<string, PerformanceCountryRow>();
  for (const row of rows) {
    const country = String(row.country ?? "")
      .trim()
      .toUpperCase();
    const metric = String(row.metric ?? "") as PerformanceMetricKey;
    if (!country || !(metric in PERFORMANCE_METRIC_COLUMNS)) continue;
    const current = byCountry.get(country) ?? {
      country,
      views: Number(row.views ?? 0),
      metrics: emptyPerformanceRouteMetrics(),
    };
    current.metrics[metric] = {
      avg: roundPerformanceValue(row.avgValue),
      p50: roundPerformanceValue(row.p50),
      p75: roundPerformanceValue(row.p75),
      p95: roundPerformanceValue(row.p95),
      samples: Number(row.samples ?? 0),
    };
    byCountry.set(country, current);
  }
  return [...byCountry.values()];
}

export async function queryPerformanceSummariesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<Record<PerformanceMetricKey, PerformanceSummaryRow>> {
  const source = performanceVisitSource(siteId, window, filters);
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
metric_visits AS (
  ${performanceMetricVisitsSql("filtered_visits")}
),
ordered_values AS (
  SELECT
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY metric) AS sampleCount
  FROM metric_visits
),
metric_thresholds AS (
  SELECT
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY metric, sampleCount
)
SELECT
  thresholds.metric AS metric,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM metric_thresholds thresholds
JOIN ordered_values ordered
  ON ordered.metric = thresholds.metric
GROUP BY thresholds.metric, thresholds.sampleCount, thresholds.avgValue
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...source.filterBindings,
  ]);
  return mapPerformanceSummaries(rows);
}

export async function queryPerformanceTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  metric: PerformanceMetricKey,
): Promise<PerformanceTrendPointRow[]> {
  const source = performanceVisitSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const column = performanceMetricColumn(metric);
  const filteredClause = appendSqlConditions(source.filterClause, [
    `${column} IS NOT NULL`,
  ]);
  const sql = `
WITH
${source.ctes},
metric_visits AS (
  SELECT
    ${bucket.sql} AS bucket,
    ${column} AS metricValue
  FROM ${source.relation}
  ${filteredClause}
),
ordered_values AS (
  SELECT
    bucket,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY bucket) AS sampleCount
  FROM metric_visits
),
bucket_thresholds AS (
  SELECT
    bucket,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY bucket, sampleCount
)
SELECT
  thresholds.bucket AS bucket,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM bucket_thresholds thresholds
JOIN ordered_values ordered
  ON ordered.bucket = thresholds.bucket
GROUP BY thresholds.bucket, thresholds.sampleCount, thresholds.avgValue
ORDER BY thresholds.bucket ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...source.bindings,
      ...bucket.bindings,
      ...source.filterBindings,
    ])
  ).map((row) => ({
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    avg: roundPerformanceValue(row.avgValue),
    p50: roundPerformanceValue(row.p50),
    p75: roundPerformanceValue(row.p75),
    p95: roundPerformanceValue(row.p95),
    samples: Number(row.samples ?? 0),
  }));
}

export async function queryAllPerformanceTrendsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
): Promise<Record<PerformanceMetricKey, PerformanceTrendPointRow[]>> {
  const source = performanceVisitSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const sql = `
WITH
${source.ctes},
bucketed_visits AS MATERIALIZED (
  SELECT
    ${bucket.sql} AS bucket,
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
metric_visits AS (
  ${performanceMetricVisitsSql("bucketed_visits", ["bucket"])}
),
ordered_values AS (
  SELECT
    metric,
    bucket,
    metricValue,
    ROW_NUMBER() OVER (
      PARTITION BY metric, bucket
      ORDER BY metricValue ASC
    ) AS rowNum,
    COUNT(*) OVER (PARTITION BY metric, bucket) AS sampleCount
  FROM metric_visits
),
bucket_thresholds AS (
  SELECT
    metric,
    bucket,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY metric, bucket, sampleCount
)
SELECT
  thresholds.metric AS metric,
  thresholds.bucket AS bucket,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM bucket_thresholds thresholds
JOIN ordered_values ordered
  ON ordered.metric = thresholds.metric
 AND ordered.bucket = thresholds.bucket
GROUP BY
  thresholds.metric,
  thresholds.bucket,
  thresholds.sampleCount,
  thresholds.avgValue
ORDER BY thresholds.metric ASC, thresholds.bucket ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...bucket.bindings,
    ...source.filterBindings,
  ]);
  return mapPerformanceTrends(rows, buckets);
}

export async function queryPerformanceRoutesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<PerformanceRouteRow[]> {
  const source = performanceVisitSource(siteId, window, filters);
  const pathExpr = "COALESCE(NULLIF(trim(pathname), ''), '/')";
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${pathExpr} AS pathname,
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
path_views AS (
  SELECT
    pathname,
    count(*) AS views
  FROM filtered_visits
  GROUP BY pathname
  ORDER BY views DESC, pathname ASC
  LIMIT ?
),
metric_visits AS (
  ${performanceMetricVisitsSql("filtered_visits", ["pathname"])}
),
scoped_metric_visits AS (
  SELECT metric_visits.*
  FROM metric_visits
  JOIN path_views ON path_views.pathname = metric_visits.pathname
),
ordered_values AS (
  SELECT
    pathname,
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY pathname, metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY pathname, metric) AS sampleCount
  FROM scoped_metric_visits
),
metric_thresholds AS (
  SELECT
    pathname,
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY pathname, metric, sampleCount
)
SELECT
  thresholds.pathname AS pathname,
  thresholds.metric AS metric,
  path_views.views AS views,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM metric_thresholds thresholds
JOIN ordered_values ordered
  ON ordered.pathname = thresholds.pathname
 AND ordered.metric = thresholds.metric
JOIN path_views ON path_views.pathname = thresholds.pathname
GROUP BY
  thresholds.pathname,
  thresholds.metric,
  path_views.views,
  thresholds.sampleCount,
  thresholds.avgValue
ORDER BY path_views.views DESC, thresholds.pathname ASC, thresholds.metric ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...source.filterBindings,
    limit,
  ]);
  return mapPerformanceRoutes(rows);
}

export async function queryPerformanceCountriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<PerformanceCountryRow[]> {
  const source = performanceVisitSource(siteId, window, filters);
  const countryExpr = "UPPER(TRIM(COALESCE(country, '')))";
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${countryExpr} AS country,
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
country_views AS (
  SELECT
    country,
    count(*) AS views
  FROM filtered_visits
  WHERE country != ''
  GROUP BY country
),
metric_visits AS (
  ${performanceMetricVisitsSql("filtered_visits", ["country"])}
),
scoped_metric_visits AS (
  SELECT metric_visits.*
  FROM metric_visits
  WHERE country != ''
),
ordered_values AS (
  SELECT
    country,
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY country, metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY country, metric) AS sampleCount
  FROM scoped_metric_visits
),
metric_thresholds AS (
  SELECT
    country,
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM ordered_values
  GROUP BY country, metric, sampleCount
)
SELECT
  thresholds.country AS country,
  thresholds.metric AS metric,
  country_views.views AS views,
  thresholds.sampleCount AS samples,
  thresholds.avgValue AS avgValue,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
  MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
FROM metric_thresholds thresholds
JOIN ordered_values ordered
  ON ordered.country = thresholds.country
 AND ordered.metric = thresholds.metric
JOIN country_views ON country_views.country = thresholds.country
GROUP BY
  thresholds.country,
  thresholds.metric,
  country_views.views,
  thresholds.sampleCount,
  thresholds.avgValue
ORDER BY country_views.views DESC, thresholds.country ASC, thresholds.metric ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...source.filterBindings,
  ]);
  return mapPerformanceCountries(rows);
}

export async function queryPerformanceDashboardFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  routeLimit: number,
): Promise<{
  summaries: Record<PerformanceMetricKey, PerformanceSummaryRow>;
  trends: Record<PerformanceMetricKey, PerformanceTrendPointRow[]>;
  routes: PerformanceRouteRow[];
  countries: PerformanceCountryRow[];
}> {
  const source = performanceVisitSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const pathExpr = "COALESCE(NULLIF(trim(pathname), ''), '/')";
  const countryExpr = "UPPER(TRIM(COALESCE(country, '')))";
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${bucket.sql} AS bucket,
    ${pathExpr} AS pathname,
    ${countryExpr} AS country,
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM ${source.relation}
  ${source.filterClause}
),
performance_visits AS MATERIALIZED (
  SELECT
    bucket,
    pathname,
    country,
    perf_ttfb_ms,
    perf_fcp_ms,
    perf_lcp_ms,
    perf_cls,
    perf_inp_ms
  FROM filtered_visits
  WHERE ${performanceMetricPresenceSql()}
),
metric_visits AS MATERIALIZED (
  ${performanceMetricVisitsSql("performance_visits", [
    "bucket",
    "pathname",
    "country",
  ])}
),
summary_ordered_values AS (
  SELECT
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (PARTITION BY metric) AS sampleCount
  FROM metric_visits
),
summary_thresholds AS (
  SELECT
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM summary_ordered_values
  GROUP BY metric, sampleCount
),
summary_rows AS (
  SELECT
    thresholds.metric AS metric,
    thresholds.sampleCount AS samples,
    thresholds.avgValue AS avgValue,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
  FROM summary_thresholds thresholds
  JOIN summary_ordered_values ordered
    ON ordered.metric = thresholds.metric
  GROUP BY thresholds.metric, thresholds.sampleCount, thresholds.avgValue
),
trend_ordered_values AS (
  SELECT
    metric,
    bucket,
    metricValue,
    ROW_NUMBER() OVER (
      PARTITION BY metric, bucket
      ORDER BY metricValue ASC
    ) AS rowNum,
    COUNT(*) OVER (PARTITION BY metric, bucket) AS sampleCount
  FROM metric_visits
),
trend_thresholds AS (
  SELECT
    metric,
    bucket,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM trend_ordered_values
  GROUP BY metric, bucket, sampleCount
),
trend_rows AS (
  SELECT
    thresholds.metric AS metric,
    thresholds.bucket AS bucket,
    thresholds.sampleCount AS samples,
    thresholds.avgValue AS avgValue,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
  FROM trend_thresholds thresholds
  JOIN trend_ordered_values ordered
    ON ordered.metric = thresholds.metric
   AND ordered.bucket = thresholds.bucket
  GROUP BY
    thresholds.metric,
    thresholds.bucket,
    thresholds.sampleCount,
    thresholds.avgValue
),
path_views AS (
  SELECT pathname, count(*) AS views
  FROM filtered_visits
  GROUP BY pathname
  ORDER BY views DESC, pathname ASC
  LIMIT ?
),
route_ordered_values AS (
  SELECT
    metric_visits.pathname,
    metric_visits.metric,
    metric_visits.metricValue,
    ROW_NUMBER() OVER (
      PARTITION BY metric_visits.pathname, metric_visits.metric
      ORDER BY metric_visits.metricValue ASC
    ) AS rowNum,
    COUNT(*) OVER (
      PARTITION BY metric_visits.pathname, metric_visits.metric
    ) AS sampleCount
  FROM metric_visits
  JOIN path_views ON path_views.pathname = metric_visits.pathname
),
route_thresholds AS (
  SELECT
    pathname,
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM route_ordered_values
  GROUP BY pathname, metric, sampleCount
),
route_rows AS (
  SELECT
    thresholds.pathname AS pathname,
    thresholds.metric AS metric,
    path_views.views AS views,
    thresholds.sampleCount AS samples,
    thresholds.avgValue AS avgValue,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
  FROM route_thresholds thresholds
  JOIN route_ordered_values ordered
    ON ordered.pathname = thresholds.pathname
   AND ordered.metric = thresholds.metric
  JOIN path_views ON path_views.pathname = thresholds.pathname
  GROUP BY
    thresholds.pathname,
    thresholds.metric,
    path_views.views,
    thresholds.sampleCount,
    thresholds.avgValue
),
country_views AS (
  SELECT country, count(*) AS views
  FROM filtered_visits
  WHERE country != ''
  GROUP BY country
),
country_ordered_values AS (
  SELECT
    metric_visits.country,
    metric_visits.metric,
    metric_visits.metricValue,
    ROW_NUMBER() OVER (
      PARTITION BY metric_visits.country, metric_visits.metric
      ORDER BY metric_visits.metricValue ASC
    ) AS rowNum,
    COUNT(*) OVER (
      PARTITION BY metric_visits.country, metric_visits.metric
    ) AS sampleCount
  FROM metric_visits
  JOIN country_views ON country_views.country = metric_visits.country
),
country_thresholds AS (
  SELECT
    country,
    metric,
    sampleCount,
    AVG(metricValue) AS avgValue,
    CAST(((sampleCount * 50) + 99) / 100 AS INTEGER) AS p50Rank,
    CAST(((sampleCount * 75) + 99) / 100 AS INTEGER) AS p75Rank,
    CAST(((sampleCount * 95) + 99) / 100 AS INTEGER) AS p95Rank
  FROM country_ordered_values
  GROUP BY country, metric, sampleCount
),
country_rows AS (
  SELECT
    thresholds.country AS country,
    thresholds.metric AS metric,
    country_views.views AS views,
    thresholds.sampleCount AS samples,
    thresholds.avgValue AS avgValue,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p50Rank THEN ordered.metricValue END) AS p50,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p75Rank THEN ordered.metricValue END) AS p75,
    MIN(CASE WHEN ordered.rowNum >= thresholds.p95Rank THEN ordered.metricValue END) AS p95
  FROM country_thresholds thresholds
  JOIN country_ordered_values ordered
    ON ordered.country = thresholds.country
   AND ordered.metric = thresholds.metric
  JOIN country_views ON country_views.country = thresholds.country
  GROUP BY
    thresholds.country,
    thresholds.metric,
    country_views.views,
    thresholds.sampleCount,
    thresholds.avgValue
),
tagged_rows AS (
  SELECT
    'summary' AS rowType,
    metric,
    NULL AS bucket,
    NULL AS pathname,
    NULL AS country,
    NULL AS views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM summary_rows
  UNION ALL
  SELECT
    'trend' AS rowType,
    metric,
    bucket,
    NULL AS pathname,
    NULL AS country,
    NULL AS views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM trend_rows
  UNION ALL
  SELECT
    'route' AS rowType,
    metric,
    NULL AS bucket,
    pathname,
    NULL AS country,
    views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM route_rows
  UNION ALL
  SELECT
    'country' AS rowType,
    metric,
    NULL AS bucket,
    NULL AS pathname,
    country,
    views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM country_rows
)
SELECT
  rowType,
  metric,
  bucket,
  pathname,
  country,
  views,
  samples,
  avgValue,
  p50,
  p75,
  p95
FROM tagged_rows
ORDER BY rowType ASC, metric ASC, bucket ASC, pathname ASC, country ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...bucket.bindings,
    ...source.filterBindings,
    routeLimit,
  ]);
  return {
    summaries: mapPerformanceSummaries(
      rows.filter((row) => row.rowType === "summary"),
    ),
    trends: mapPerformanceTrends(
      rows.filter((row) => row.rowType === "trend"),
      buckets,
    ),
    routes: mapPerformanceRoutes(rows.filter((row) => row.rowType === "route")),
    countries: mapPerformanceCountries(
      rows.filter((row) => row.rowType === "country"),
    ),
  };
}
