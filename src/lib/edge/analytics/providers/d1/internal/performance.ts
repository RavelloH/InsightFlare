import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildPerformanceAllTrendsPlan,
  buildPerformanceCountriesPlan,
  buildPerformanceDashboardPlan,
  buildPerformanceRoutesPlan,
  buildPerformanceSummariesPlan,
  buildPerformanceTrendPlan,
  PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
  PERFORMANCE_COUNTRIES_OUTPUT_IDS,
  PERFORMANCE_DASHBOARD_OUTPUT_IDS,
  PERFORMANCE_METRICS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
  PERFORMANCE_ROUTES_OUTPUT_IDS,
  PERFORMANCE_SUMMARY_OUTPUT_ID,
  PERFORMANCE_TREND_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import type { Env } from "@/lib/edge/types";

import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
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
  buildTimeBuckets,
  emptyPerformanceRouteMetrics,
  normalizePathname,
  PERFORMANCE_METRIC_COLUMNS,
  PERFORMANCE_METRIC_KEYS,
  roundPerformanceValue,
  timeBucketTimestamp,
} from "./core";
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
  const row = rows[0];
  if (!row) return summaries;
  for (const metric of PERFORMANCE_METRIC_KEYS) {
    const samples = Number(row[`${metric}Samples`] ?? 0);
    if (samples === 0) continue;
    summaries[metric] = {
      avg: roundPerformanceValue(row[`${metric}AvgValue`]),
      p50: roundPerformanceValue(row[`${metric}P50`]),
      p75: roundPerformanceValue(row[`${metric}P75`]),
      p95: roundPerformanceValue(row[`${metric}P95`]),
      samples,
    };
  }
  return summaries;
}

function mapLegacyPerformanceSummaries(
  rows: Record<string, unknown>[],
): Record<PerformanceMetricKey, PerformanceSummaryRow> {
  const summaries = emptyPerformanceSummaries();
  for (const row of performanceMetricRows(rows)) {
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

function performanceMetricRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.flatMap((row) => {
    const metric = String(row.metric ?? "");
    const descriptor = PERFORMANCE_METRICS.find(
      (candidate) => candidate.key === metric,
    );
    if (!descriptor) return [];
    return [
      {
        ...row,
        samples: row[`${descriptor.key}Samples`],
        avgValue: row[`${descriptor.key}AvgValue`],
        p50: row[`${descriptor.key}P50`],
        p75: row[`${descriptor.key}P75`],
        p95: row[`${descriptor.key}P95`],
      },
    ];
  });
}

function performancePlanInput(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const metadata = scopedFilterMetadata(filters);
  return {
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
  };
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
  const plan = buildPerformanceSummariesPlan(
    performancePlanInput(siteId, window, filters),
  );
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PERFORMANCE_SUMMARY_OUTPUT_ID,
  );
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
  const plan = buildPerformanceTrendPlan({
    ...performancePlanInput(siteId, window, filters),
    interval,
    metric,
  });
  const buckets = buildTimeBuckets(window, interval);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PERFORMANCE_TREND_OUTPUT_ID,
  );
  return rows.flatMap((row) => {
    if (row.bucket === null || row.bucket === undefined) return [];
    const bucketIndex = Number(row.bucket);
    if (!Number.isInteger(bucketIndex)) return [];
    return [
      {
        bucket: bucketIndex,
        timestampMs: timeBucketTimestamp(buckets, bucketIndex),
        avg: roundPerformanceValue(row.avgValue),
        p50: roundPerformanceValue(row.p50),
        p75: roundPerformanceValue(row.p75),
        p95: roundPerformanceValue(row.p95),
        samples: Number(row.samples ?? 0),
      },
    ];
  });
}
export async function queryAllPerformanceTrendsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
): Promise<Record<PerformanceMetricKey, PerformanceTrendPointRow[]>> {
  const plan = buildPerformanceAllTrendsPlan({
    ...performancePlanInput(siteId, window, filters),
    interval,
  });
  const buckets = buildTimeBuckets(window, interval);
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
    fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    orderBy: [
      { field: "metric", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
    ],
  });
  return mapPerformanceTrends(performanceMetricRows(rows), buckets);
}

export async function queryPerformanceRoutesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<PerformanceRouteRow[]> {
  const plan = buildPerformanceRoutesPlan({
    ...performancePlanInput(siteId, window, filters),
    limit,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PERFORMANCE_ROUTES_OUTPUT_IDS,
    fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    orderBy: [
      { field: "views", direction: "desc", nulls: "last" },
      { field: "pathname", direction: "asc", nulls: "first" },
      { field: "metric", direction: "asc", nulls: "first" },
    ],
  });
  return mapPerformanceRoutes(performanceMetricRows(rows));
}

export async function queryPerformanceCountriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<PerformanceCountryRow[]> {
  const plan = buildPerformanceCountriesPlan(
    performancePlanInput(siteId, window, filters),
  );
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PERFORMANCE_COUNTRIES_OUTPUT_IDS,
    fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    orderBy: [
      { field: "views", direction: "desc", nulls: "last" },
      { field: "country", direction: "asc", nulls: "first" },
      { field: "metric", direction: "asc", nulls: "first" },
    ],
  });
  return mapPerformanceCountries(performanceMetricRows(rows));
}

export async function queryPerformanceDashboardFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  routeLimit: number,
): Promise<PerformanceDashboardResult> {
  const plan = buildPerformanceDashboardPlan({
    ...performancePlanInput(siteId, window, filters),
    interval,
    routeLimit,
  });
  const buckets = buildTimeBuckets(window, interval);
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PERFORMANCE_DASHBOARD_OUTPUT_IDS,
    fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    orderBy: [
      { field: "rowType", direction: "asc", nulls: "first" },
      { field: "metric", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
      { field: "pathname", direction: "asc", nulls: "first" },
      { field: "country", direction: "asc", nulls: "first" },
    ],
  });
  return {
    summaries: mapLegacyPerformanceSummaries(
      rows.filter((row) => row.rowType === "summary"),
    ),
    trends: mapPerformanceTrends(
      performanceMetricRows(rows.filter((row) => row.rowType === "trend")),
      buckets,
    ),
    routes: mapPerformanceRoutes(
      performanceMetricRows(rows.filter((row) => row.rowType === "route")),
    ),
    countries: mapPerformanceCountries(
      performanceMetricRows(rows.filter((row) => row.rowType === "country")),
    ),
  };
}
