import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  Interval,
  PerformanceCountryRow,
  PerformanceDashboardResult,
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

  const filter = buildVisitFilterSql(filters, "visit_source", { window });
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
  metrics: readonly PerformanceMetricKey[] = PERFORMANCE_METRIC_KEYS,
): string {
  const dimensionSql =
    dimensions.length > 0 ? `${dimensions.join(", ")}, ` : "";
  return metrics
    .map((metric) => {
      const column = PERFORMANCE_METRIC_COLUMNS[metric];
      return `SELECT ${dimensionSql}'${metric}' AS metric, ${column} AS metricValue
  FROM ${source}
  WHERE ${column} IS NOT NULL`;
    })
    .join("\n  UNION ALL\n  ");
}
function performanceMetricPresenceSql(): string {
  return PERFORMANCE_METRIC_KEYS.map(
    (metric) => `${PERFORMANCE_METRIC_COLUMNS[metric]} IS NOT NULL`,
  ).join(" OR ");
}
function performancePercentileValuesSql(alias = ""): string {
  const prefix = alias ? alias + "." : "";
  return [50, 75, 95]
    .map(
      (percentile) =>
        "MIN(CASE WHEN " +
        prefix +
        "rowNum >= CAST(((" +
        prefix +
        "sampleCount * " +
        percentile +
        ") + 99) / 100 AS INTEGER) THEN " +
        prefix +
        "metricValue END) AS p" +
        percentile,
    )
    .join(",\n  ");
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
    if (Number(row.missingMetric ?? 0) !== 1) {
      current.metrics[metric] = {
        avg: roundPerformanceValue(row.avgValue),
        p50: roundPerformanceValue(row.p50),
        p75: roundPerformanceValue(row.p75),
        p95: roundPerformanceValue(row.p95),
        samples: Number(row.samples ?? 0),
      };
    }
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
    if (Number(row.missingMetric ?? 0) !== 1) {
      current.metrics[metric] = {
        avg: roundPerformanceValue(row.avgValue),
        p50: roundPerformanceValue(row.p50),
        p75: roundPerformanceValue(row.p75),
        p95: roundPerformanceValue(row.p95),
        samples: Number(row.samples ?? 0),
      };
    }
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
    COUNT(*) OVER (
      PARTITION BY metric
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
)
SELECT
  metric,
  MAX(sampleCount) AS samples,
  AVG(metricValue) AS avgValue,
  ${performancePercentileValuesSql()}
FROM ordered_values
GROUP BY metric
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
    COUNT(*) OVER (
      PARTITION BY bucket
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
)
SELECT
  bucket,
  MAX(sampleCount) AS samples,
  AVG(metricValue) AS avgValue,
  ${performancePercentileValuesSql()}
FROM ordered_values
GROUP BY bucket
ORDER BY bucket ASC
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
    COUNT(*) OVER (
      PARTITION BY metric, bucket
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
)
SELECT
  metric, bucket,
  MAX(sampleCount) AS samples,
  AVG(metricValue) AS avgValue,
  ${performancePercentileValuesSql()}
FROM ordered_values
GROUP BY metric, bucket
ORDER BY metric ASC, bucket ASC
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
  metric?: PerformanceMetricKey,
): Promise<PerformanceRouteRow[]> {
  const source = performanceVisitSource(siteId, window, filters);
  const selectedMetrics = metric ? [metric] : PERFORMANCE_METRIC_KEYS;
  const pathExpr = "COALESCE(NULLIF(trim(pathname), ''), '/')";
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${pathExpr} AS pathname,
    ${selectedMetrics.map((key) => performanceMetricColumn(key)).join(",\n    ")},
    (${performanceMetricPresenceSql()}) AS has_any_performance
  FROM ${source.relation}
  ${source.filterClause}
),
path_views AS (
  SELECT
    pathname,
    count(*) AS views,
    MAX(has_any_performance) AS has_any_performance
  FROM filtered_visits
  GROUP BY pathname
  ORDER BY views DESC, pathname ASC
  LIMIT ?
),
metric_visits AS (
  ${performanceMetricVisitsSql("filtered_visits", ["pathname"], selectedMetrics)}
),
scoped_metric_visits AS (
  SELECT metric_visits.*
  FROM metric_visits
  WHERE metric_visits.pathname IN (SELECT pathname FROM path_views)
),
ordered_values AS (
  SELECT
    pathname,
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY pathname, metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (
      PARTITION BY pathname, metric
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM scoped_metric_visits
),
metric_aggregates AS (
  SELECT
    pathname, metric,
    MAX(sampleCount) AS samples,
    AVG(metricValue) AS avgValue,
    ${performancePercentileValuesSql()}
  FROM ordered_values
  GROUP BY pathname, metric
)
SELECT
  path_views.pathname AS pathname,
  ${metric ? "?" : "metric_aggregates.metric"} AS metric,
  path_views.views AS views,
  metric_aggregates.samples AS samples,
  metric_aggregates.avgValue AS avgValue,
  metric_aggregates.p50 AS p50,
  metric_aggregates.p75 AS p75,
  metric_aggregates.p95 AS p95,
  CASE WHEN metric_aggregates.metric IS NULL THEN 1 ELSE 0 END AS missingMetric
FROM path_views
LEFT JOIN metric_aggregates ON metric_aggregates.pathname = path_views.pathname
WHERE path_views.has_any_performance = 1
ORDER BY path_views.views DESC, path_views.pathname ASC, metric_aggregates.metric ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...source.filterBindings,
    limit,
    ...(metric ? [metric] : []),
  ]);
  return mapPerformanceRoutes(rows);
}
export async function queryPerformanceCountriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  metric?: PerformanceMetricKey,
): Promise<PerformanceCountryRow[]> {
  const source = performanceVisitSource(siteId, window, filters);
  const selectedMetrics = metric ? [metric] : PERFORMANCE_METRIC_KEYS;
  const countryExpr = "UPPER(TRIM(COALESCE(country, '')))";
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${countryExpr} AS country,
    ${selectedMetrics.map((key) => performanceMetricColumn(key)).join(",\n    ")},
    (${performanceMetricPresenceSql()}) AS has_any_performance
  FROM ${source.relation}
  ${source.filterClause}
),
country_views AS (
  SELECT
    country,
    count(*) AS views,
    MAX(has_any_performance) AS has_any_performance
  FROM filtered_visits
  WHERE country != ''
  GROUP BY country
  ORDER BY views DESC, country ASC
  LIMIT ?
),
metric_visits AS (
  ${performanceMetricVisitsSql("filtered_visits", ["country"], selectedMetrics)}
),
scoped_metric_visits AS (
  SELECT metric_visits.*
  FROM metric_visits
  WHERE metric_visits.country IN (SELECT country FROM country_views)
),
ordered_values AS (
  SELECT
    country,
    metric,
    metricValue,
    ROW_NUMBER() OVER (PARTITION BY country, metric ORDER BY metricValue ASC) AS rowNum,
    COUNT(*) OVER (
      PARTITION BY country, metric
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM scoped_metric_visits
),
metric_aggregates AS (
  SELECT
    country, metric,
    MAX(sampleCount) AS samples,
    AVG(metricValue) AS avgValue,
    ${performancePercentileValuesSql()}
  FROM ordered_values
  GROUP BY country, metric
)
SELECT
  country_views.country AS country,
  ${metric ? "?" : "metric_aggregates.metric"} AS metric,
  country_views.views AS views,
  metric_aggregates.samples AS samples,
  metric_aggregates.avgValue AS avgValue,
  metric_aggregates.p50 AS p50,
  metric_aggregates.p75 AS p75,
  metric_aggregates.p95 AS p95,
  CASE WHEN metric_aggregates.metric IS NULL THEN 1 ELSE 0 END AS missingMetric
FROM country_views
LEFT JOIN metric_aggregates ON metric_aggregates.country = country_views.country
WHERE country_views.has_any_performance = 1
ORDER BY country_views.views DESC, country_views.country ASC, metric_aggregates.metric ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...source.bindings,
    ...source.filterBindings,
    limit,
    ...(metric ? [metric] : []),
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
): Promise<PerformanceDashboardResult> {
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
    COUNT(*) OVER (
      PARTITION BY metric
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
),
summary_rows AS (
  SELECT
    ordered.metric,
    MAX(ordered.sampleCount) AS samples,
    AVG(ordered.metricValue) AS avgValue,
    ${performancePercentileValuesSql("ordered")}
  FROM summary_ordered_values ordered
  GROUP BY ordered.metric
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
    COUNT(*) OVER (
      PARTITION BY metric, bucket
      ORDER BY metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
),
trend_rows AS (
  SELECT
    ordered.metric,
    ordered.bucket,
    MAX(ordered.sampleCount) AS samples,
    AVG(ordered.metricValue) AS avgValue,
    ${performancePercentileValuesSql("ordered")}
  FROM trend_ordered_values ordered
  GROUP BY ordered.metric, ordered.bucket
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
      ORDER BY metric_visits.metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
  WHERE metric_visits.pathname IN (SELECT pathname FROM path_views)
),
route_rows AS (
  SELECT
    ordered.pathname,
    ordered.metric,
    MAX(ordered.sampleCount) AS samples,
    AVG(ordered.metricValue) AS avgValue,
    ${performancePercentileValuesSql("ordered")}
  FROM route_ordered_values ordered
  GROUP BY ordered.pathname, ordered.metric
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
      ORDER BY metric_visits.metricValue ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS sampleCount
  FROM metric_visits
  WHERE metric_visits.country != ''
),
country_rows AS (
  SELECT
    ordered.country,
    ordered.metric,
    MAX(ordered.sampleCount) AS samples,
    AVG(ordered.metricValue) AS avgValue,
    ${performancePercentileValuesSql("ordered")}
  FROM country_ordered_values ordered
  GROUP BY ordered.country, ordered.metric
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
    route_rows.pathname,
    NULL AS country,
    path_views.views AS views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM route_rows
  JOIN path_views ON path_views.pathname = route_rows.pathname
  UNION ALL
  SELECT
    'country' AS rowType,
    metric,
    NULL AS bucket,
    NULL AS pathname,
    country_rows.country,
    country_views.views AS views,
    samples,
    avgValue,
    p50,
    p75,
    p95
  FROM country_rows
  JOIN country_views ON country_views.country = country_rows.country
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
