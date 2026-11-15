import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
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
import { pageRoleDependencyRefs } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { DeferredPerformanceSummaryQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { PageVisitQualificationPreparation } from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
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
import type { D1ExecutionOptions } from "./execution-options";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";
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
export function mapPerformanceSummaries(
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
  qualification?: PerformancePageVisitQualification,
) {
  const metadata = scopedFilterMetadata(filters);
  return {
    siteId,
    queryTime: qualification?.queryTime ?? queryWindowToTime(window),
    filters,
    ...(qualification
      ? {
          scopePlan: qualification.scopePlan,
          qualificationDependencyRefs: pageRoleDependencyRefs(
            qualification.scopePlan,
          ),
        }
      : metadata
        ? {
            scopePlan: metadata.plan,
            preparedTimePolicy: "reader-window-v1" as const,
          }
        : {}),
  };
}

export interface PerformancePageVisitQualification {
  readonly preparation: PageVisitQualificationPreparation;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly configuration: DeferredPerformanceSummaryQualification["configuration"];
}

export function performancePageVisitQualificationConsumerKey(
  configuration: PerformancePageVisitQualification["configuration"],
) {
  return pageVisitQualificationConsumerKey("performance-report", configuration);
}

function bindPerformanceQualification(input: {
  readonly plan: ValidatedLogicalPlan;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly qualification?: PerformancePageVisitQualification;
}): {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs?: QualificationExecutionInputs;
} {
  if (!input.qualification) return { plan: input.plan };
  const plan = snapshotPageVisitQualificationPlan(input.plan);
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation: input.qualification.preparation,
    siteId: input.siteId,
    filters: input.filters,
    queryTime: input.qualification.queryTime,
    scopePlan: input.qualification.scopePlan,
    consumerKey: performancePageVisitQualificationConsumerKey(
      input.qualification.configuration,
    ),
    plan,
  });
  return { plan, executionInputs };
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
export function mapPerformanceTrendReportRows(
  rows: Record<string, unknown>[],
  window: QueryWindow,
  interval: Interval,
): Record<PerformanceMetricKey, PerformanceTrendPointRow[]> {
  return mapPerformanceTrends(
    performanceMetricRows(rows),
    buildTimeBuckets(window, interval),
  );
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

export function mapPerformanceRouteReportRows(
  rows: Record<string, unknown>[],
): PerformanceRouteRow[] {
  return mapPerformanceRoutes(performanceMetricRows(rows));
}

export function mapPerformanceCountryReportRows(
  rows: Record<string, unknown>[],
): PerformanceCountryRow[] {
  return mapPerformanceCountries(performanceMetricRows(rows));
}

export function mapPerformanceDashboardReportRows(
  rows: Record<string, unknown>[],
  window: QueryWindow,
  interval: Interval,
): PerformanceDashboardResult {
  const buckets = buildTimeBuckets(window, interval);
  return {
    summaries: mapLegacyPerformanceSummaries(
      rows.filter((row) => row.rowType === "summary"),
    ),
    trends: mapPerformanceTrends(
      performanceMetricRows(rows.filter((row) => row.rowType === "trend")),
      buckets,
    ),
    routes: mapPerformanceRouteReportRows(
      rows.filter((row) => row.rowType === "route"),
    ),
    countries: mapPerformanceCountryReportRows(
      rows.filter((row) => row.rowType === "country"),
    ),
  };
}
export async function queryPerformanceSummariesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  qualification?: PerformancePageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<Record<PerformanceMetricKey, PerformanceSummaryRow>> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "performance",
            reader: { kind: "performance-summary", configuration: {} },
          },
          siteId,
          filters,
          queryTime: scopedFilterMetadata(filters)?.time ?? planInput.queryTime,
          scopePlan: "scopePlan" in planInput ? planInput.scopePlan : undefined,
          readerQueryTime: planInput.queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const bound =
    wholeOriginal ??
    bindPerformanceQualification({
      plan: buildPerformanceSummariesPlan(planInput),
      siteId,
      filters,
      qualification,
    });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    bound.plan,
    PERFORMANCE_SUMMARY_OUTPUT_ID,
    undefined,
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
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
  qualification?: PerformancePageVisitQualification,
): Promise<PerformanceTrendPointRow[]> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const bound = bindPerformanceQualification({
    plan: buildPerformanceTrendPlan({
      ...planInput,
      interval,
      metric,
    }),
    siteId,
    filters,
    qualification,
  });
  const buckets = buildTimeBuckets(window, interval);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    bound.plan,
    PERFORMANCE_TREND_OUTPUT_ID,
    undefined,
    undefined,
    bound.executionInputs,
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
  qualification?: PerformancePageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<Record<PerformanceMetricKey, PerformanceTrendPointRow[]>> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "performance",
            reader: {
              kind: "performance-all-trends",
              configuration: { interval },
            },
          },
          siteId,
          filters,
          queryTime: scopedFilterMetadata(filters)?.time ?? planInput.queryTime,
          scopePlan: "scopePlan" in planInput ? planInput.scopePlan : undefined,
          readerQueryTime: planInput.queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const bound =
    wholeOriginal ??
    bindPerformanceQualification({
      plan: buildPerformanceAllTrendsPlan({
        ...planInput,
        interval,
      }),
      siteId,
      filters,
      qualification,
    });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    bound.plan,
    {
      outputIds: PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
      fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
      orderBy: [
        { field: "metric", direction: "asc", nulls: "first" },
        { field: "bucket", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
  );
  return mapPerformanceTrendReportRows(rows, window, interval);
}

export async function queryPerformanceRoutesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  qualification?: PerformancePageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<PerformanceRouteRow[]> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "performance",
            reader: { kind: "performance-routes", configuration: { limit } },
          },
          siteId,
          filters,
          queryTime: scopedFilterMetadata(filters)?.time ?? planInput.queryTime,
          scopePlan: "scopePlan" in planInput ? planInput.scopePlan : undefined,
          readerQueryTime: planInput.queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const bound =
    wholeOriginal ??
    bindPerformanceQualification({
      plan: buildPerformanceRoutesPlan({ ...planInput, limit }),
      siteId,
      filters,
      qualification,
    });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    bound.plan,
    {
      outputIds: PERFORMANCE_ROUTES_OUTPUT_IDS,
      fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
      orderBy: [
        { field: "views", direction: "desc", nulls: "last" },
        { field: "pathname", direction: "asc", nulls: "first" },
        { field: "metric", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
  );
  return mapPerformanceRouteReportRows(rows);
}

export async function queryPerformanceCountriesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  qualification?: PerformancePageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<PerformanceCountryRow[]> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "performance",
            reader: { kind: "performance-countries", configuration: {} },
          },
          siteId,
          filters,
          queryTime: scopedFilterMetadata(filters)?.time ?? planInput.queryTime,
          scopePlan: "scopePlan" in planInput ? planInput.scopePlan : undefined,
          readerQueryTime: planInput.queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const bound =
    wholeOriginal ??
    bindPerformanceQualification({
      plan: buildPerformanceCountriesPlan(planInput),
      siteId,
      filters,
      qualification,
    });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    bound.plan,
    {
      outputIds: PERFORMANCE_COUNTRIES_OUTPUT_IDS,
      fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
      orderBy: [
        { field: "views", direction: "desc", nulls: "last" },
        { field: "country", direction: "asc", nulls: "first" },
        { field: "metric", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
  );
  return mapPerformanceCountryReportRows(rows);
}

export async function queryPerformanceDashboardFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  routeLimit: number,
  qualification?: PerformancePageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<PerformanceDashboardResult> {
  const planInput = performancePlanInput(
    siteId,
    window,
    filters,
    qualification,
  );
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "performance",
            reader: {
              kind: "performance-dashboard",
              configuration: { interval, routeLimit },
            },
          },
          siteId,
          filters,
          queryTime: scopedFilterMetadata(filters)?.time ?? planInput.queryTime,
          scopePlan: "scopePlan" in planInput ? planInput.scopePlan : undefined,
          readerQueryTime: planInput.queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const bound =
    wholeOriginal ??
    bindPerformanceQualification({
      plan: buildPerformanceDashboardPlan({
        ...planInput,
        interval,
        routeLimit,
      }),
      siteId,
      filters,
      qualification,
    });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    bound.plan,
    {
      outputIds: PERFORMANCE_DASHBOARD_OUTPUT_IDS,
      fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
      orderBy: [
        { field: "rowType", direction: "asc", nulls: "first" },
        { field: "metric", direction: "asc", nulls: "first" },
        { field: "bucket", direction: "asc", nulls: "first" },
        { field: "pathname", direction: "asc", nulls: "first" },
        { field: "country", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
  );
  return mapPerformanceDashboardReportRows(rows, window, interval);
}
