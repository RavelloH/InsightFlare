import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  Interval,
  PerformanceMetricKey,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const PERFORMANCE_SUMMARY_OUTPUT_ID = "performance-summaries";
export const PERFORMANCE_TREND_OUTPUT_ID = "performance-trend";

export const PERFORMANCE_METRICS = [
  { key: "ttfb", attribute: "perfTtfbMs" },
  { key: "fcp", attribute: "perfFcpMs" },
  { key: "lcp", attribute: "perfLcpMs" },
  { key: "cls", attribute: "perfCls" },
  { key: "inp", attribute: "perfInpMs" },
] as const satisfies readonly {
  readonly key: PerformanceMetricKey;
  readonly attribute: string;
}[];

const METRICS = PERFORMANCE_METRICS;

function metricOutputIds(report: "summary" | "trend" | "route" | "country") {
  return PERFORMANCE_METRICS.map(
    ({ key }) => `performance-${report}-${key}` as const,
  );
}

export const PERFORMANCE_ALL_TRENDS_OUTPUT_IDS = metricOutputIds("trend");
export const PERFORMANCE_ROUTES_OUTPUT_IDS = metricOutputIds("route");
export const PERFORMANCE_COUNTRIES_OUTPUT_IDS = metricOutputIds("country");
export const PERFORMANCE_DASHBOARD_OUTPUT_IDS = [
  ...metricOutputIds("summary"),
  ...metricOutputIds("trend"),
  ...metricOutputIds("route"),
  ...metricOutputIds("country"),
] as const;

export const PERFORMANCE_REPORT_OUTPUT_FIELDS = [
  "rowType",
  "metric",
  "bucket",
  "pathname",
  "country",
  "views",
  ...PERFORMANCE_METRICS.flatMap(({ key }) => [
    `${key}Samples`,
    `${key}AvgValue`,
    `${key}P50`,
    `${key}P75`,
    `${key}P95`,
  ]),
] as const;

const STRING_TYPE = { kind: "scalar", scalar: "string" } as const;
const NUMBER_TYPE = { kind: "scalar", scalar: "number" } as const;
const MS_TYPE = { kind: "scalar", scalar: "number", unit: "ms" } as const;
const RATIO_TYPE = {
  kind: "scalar",
  scalar: "number",
  unit: "ratio",
} as const;
const SAMPLE_PERCENTILES = [
  { name: "p50", percentile: 50 },
  { name: "p75", percentile: 75 },
  { name: "p95", percentile: 95 },
] as const;
function metricDescriptor(metric: PerformanceMetricKey) {
  const descriptor = METRICS.find((candidate) => candidate.key === metric);
  if (!descriptor) throw new Error("performance_invalid_metric");
  return descriptor;
}

function pageAttribute(
  builder: ReturnType<typeof createPageReportSource>["builder"],
  pages: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function createSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly attributes: readonly string[];
}) {
  return createPageReportSource(input);
}

function metricFields(prefix: string) {
  return [
    { name: `${prefix}Samples`, slot: `${prefix}Samples` },
    { name: `${prefix}AvgValue`, slot: `${prefix}AvgValue` },
    { name: `${prefix}P50`, slot: `${prefix}P50` },
    { name: `${prefix}P75`, slot: `${prefix}P75` },
    { name: `${prefix}P95`, slot: `${prefix}P95` },
  ] as const;
}

export function buildPerformanceSummariesPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
}): ValidatedLogicalPlan {
  const source = createSource({
    ...input,
    attributes: METRICS.map(({ attribute }) => `page.report.${attribute}`),
  });
  const branches = METRICS.map(({ key, attribute }) => {
    const value = pageAttribute(source.builder, source.pages, attribute);
    const statistics = source.builder.sampleStatistics(
      source.pages,
      {},
      value,
      [...SAMPLE_PERCENTILES],
    );
    const renamed = source.builder.project(statistics, {
      [`${key}Samples`]: source.builder.slot(statistics, "samples"),
      [`${key}AvgValue`]: source.builder.slot(statistics, "avg"),
      [`${key}P50`]: source.builder.slot(statistics, "p50"),
      [`${key}P75`]: source.builder.slot(statistics, "p75"),
      [`${key}P95`]: source.builder.slot(statistics, "p95"),
    });
    return { relation: renamed };
  });

  let joined = branches[0]!.relation;
  for (const branch of branches.slice(1)) {
    joined = source.builder.join(joined, branch.relation, [], "inner");
  }

  const fields = METRICS.flatMap(({ key }, index) =>
    metricFields(key).map(({ name, slot }) => ({
      name,
      slot: index === 0 ? slot : `right.${slot}`,
    })),
  );
  source.builder.output(PERFORMANCE_SUMMARY_OUTPUT_ID, joined, fields);
  return source.builder.finish();
}

export function buildPerformanceTrendPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly interval: Interval;
  readonly metric: PerformanceMetricKey;
}): ValidatedLogicalPlan {
  const descriptor = metricDescriptor(input.metric);
  const source = createSource({
    ...input,
    attributes: [
      "page.report.startedAt",
      `page.report.${descriptor.attribute}`,
    ],
  });
  const startedAt = pageAttribute(source.builder, source.pages, "startedAt");
  const value = pageAttribute(
    source.builder,
    source.pages,
    descriptor.attribute,
  );
  const selected = source.builder.project(source.pages, {
    bucket: source.builder.bucketIndex(
      source.builder.timeBucket(startedAt, input.interval),
    ),
    metricValue: value,
  });
  const bucket = source.builder.slot(selected, "bucket");
  const nonNullBuckets = source.builder.filter(
    selected,
    source.builder.isNull(bucket, true),
  );
  const statistics = source.builder.sampleStatistics(
    nonNullBuckets,
    { bucket: source.builder.slot(nonNullBuckets, "bucket") },
    source.builder.slot(nonNullBuckets, "metricValue"),
    [...SAMPLE_PERCENTILES],
  );
  const sorted = source.builder.sort(statistics, [
    { slot: "bucket", direction: "asc", nulls: "last" },
  ]);
  source.builder.output(PERFORMANCE_TREND_OUTPUT_ID, sorted, [
    { name: "bucket", slot: "bucket" },
    { name: "samples", slot: "samples" },
    { name: "avgValue", slot: "avg" },
    { name: "p50", slot: "p50" },
    { name: "p75", slot: "p75" },
    { name: "p95", slot: "p95" },
  ]);
  return source.builder.finish();
}

type PerformanceReportInput = {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
};

function metricType(
  metric: PerformanceMetricKey,
): Extract<LogicalValueType, { readonly kind: "scalar" }> {
  return metric === "cls" ? RATIO_TYPE : MS_TYPE;
}

function createMultiReportSource(
  input: PerformanceReportInput,
  attributes: readonly string[],
) {
  return createSource({ ...input, attributes });
}

function pathExpression(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
) {
  const raw = pageAttribute(builder, pages, "pathname");
  const trimmed = builder.normalizeString(raw, "trim-ascii-space");
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", trimmed, builder.literal("", STRING_TYPE)),
        then: trimmed,
      },
    ],
    builder.literal("/", STRING_TYPE),
  );
}

function countryExpression(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
) {
  return builder.pageDimension("countryCode", {
    "page.report.country": pageAttribute(builder, pages, "country"),
  });
}

function reportPages(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: {
    readonly interval?: Interval;
    readonly path?: boolean;
    readonly country?: boolean;
  },
) {
  const projections: Record<
    string,
    ReturnType<LogicalPlanBuilder["slot"]>
  > = {};
  if (options.interval) {
    projections.bucket = builder.bucketIndex(
      builder.timeBucket(
        pageAttribute(builder, pages, "startedAt"),
        options.interval,
      ),
    );
  }
  if (options.path) projections.pathname = pathExpression(builder, pages);
  if (options.country) projections.country = countryExpression(builder, pages);
  for (const { key, attribute } of PERFORMANCE_METRICS)
    projections[key] = pageAttribute(builder, pages, attribute);
  return builder.project(pages, projections);
}

function wireMetricOutput(
  builder: LogicalPlanBuilder,
  report: "summary" | "trend" | "route" | "country",
  metric: PerformanceMetricKey,
  relation: LogicalRelationHandle,
  options: {
    readonly bucket?: string;
    readonly pathname?: string;
    readonly country?: string;
    readonly views?: string;
  } = {},
) {
  const projections: Record<string, ReturnType<LogicalPlanBuilder["slot"]>> = {
    rowType: builder.literal(report, STRING_TYPE),
    metric: builder.literal(metric, STRING_TYPE),
    bucket: options.bucket
      ? builder.slot(relation, options.bucket)
      : builder.literal(null, NUMBER_TYPE),
    pathname: options.pathname
      ? builder.slot(relation, options.pathname)
      : builder.literal(null, STRING_TYPE),
    country: options.country
      ? builder.slot(relation, options.country)
      : builder.literal(null, STRING_TYPE),
    views: options.views
      ? builder.slot(relation, options.views)
      : builder.literal(null, NUMBER_TYPE),
  };
  for (const descriptor of PERFORMANCE_METRICS) {
    const current = descriptor.key === metric;
    for (const [suffix, source] of [
      ["Samples", "samples"],
      ["AvgValue", "avg"],
      ["P50", "p50"],
      ["P75", "p75"],
      ["P95", "p95"],
    ] as const) {
      projections[`${descriptor.key}${suffix}`] = current
        ? builder.slot(relation, source)
        : builder.literal(
            null,
            source === "samples" ? NUMBER_TYPE : metricType(descriptor.key),
          );
    }
  }
  const wire = builder.project(relation, projections);
  const outputId = `performance-${report}-${metric}`;
  builder.output(
    outputId,
    wire,
    PERFORMANCE_REPORT_OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
  return outputId;
}

function metricStatistics(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  metric: PerformanceMetricKey,
  groups: Readonly<Record<string, ReturnType<LogicalPlanBuilder["slot"]>>> = {},
) {
  return builder.sampleStatistics(
    pages,
    groups,
    builder.slot(pages, metric),
    SAMPLE_PERCENTILES,
  );
}

function addTrendOutputs(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  report: "trend",
) {
  const bucketed = builder.filter(
    pages,
    builder.isNull(builder.slot(pages, "bucket"), true),
  );
  return PERFORMANCE_METRICS.map(({ key }) => {
    const stats = metricStatistics(builder, bucketed, key, {
      bucket: builder.slot(bucketed, "bucket"),
    });
    return wireMetricOutput(builder, report, key, stats, { bucket: "bucket" });
  });
}

function addRouteOutputs(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  topPaths: LogicalRelationHandle,
  report: "route",
) {
  const joinedPages = builder.join(
    pages,
    topPaths,
    [{ left: "pathname", right: "pathname" }],
    "inner",
  );
  const projections: Record<string, ReturnType<LogicalPlanBuilder["slot"]>> = {
    pathname: builder.slot(joinedPages, "pathname"),
    views: builder.slot(joinedPages, "right.views"),
  };
  for (const { key } of PERFORMANCE_METRICS)
    projections[key] = builder.slot(joinedPages, key);
  const selectedPages = builder.project(joinedPages, projections);
  return PERFORMANCE_METRICS.map(({ key }) => {
    const stats = metricStatistics(builder, selectedPages, key, {
      pathname: builder.slot(selectedPages, "pathname"),
      views: builder.slot(selectedPages, "views"),
    });
    return wireMetricOutput(builder, report, key, stats, {
      pathname: "pathname",
      views: "views",
    });
  });
}

function addCountryOutputs(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  countryViews: LogicalRelationHandle,
  report: "country",
) {
  const nonempty = builder.filter(
    pages,
    builder.compare(
      "neq",
      builder.slot(pages, "country"),
      builder.literal("", STRING_TYPE),
    ),
  );
  return PERFORMANCE_METRICS.map(({ key }) => {
    const stats = metricStatistics(builder, nonempty, key, {
      country: builder.slot(nonempty, "country"),
    });
    const withViews = builder.join(
      stats,
      countryViews,
      [{ left: "country", right: "country" }],
      "inner",
    );
    return wireMetricOutput(builder, report, key, withViews, {
      country: "country",
      views: "right.views",
    });
  });
}

function pathViews(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  limit: number,
) {
  const views = builder.aggregate(
    pages,
    { pathname: builder.slot(pages, "pathname") },
    [{ name: "views", kind: "count-rows" }],
  );
  if (limit < 0) return views;
  const ranked = builder.rankedMembers(views, {
    groups: [],
    order: [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "pathname", direction: "asc", nulls: "last" },
    ],
  });
  return builder.filter(
    ranked,
    builder.compare(
      "lte",
      builder.slot(ranked, "rank"),
      builder.literal(limit, NUMBER_TYPE),
    ),
  );
}

function countryViews(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
) {
  const nonempty = builder.filter(
    pages,
    builder.compare(
      "neq",
      builder.slot(pages, "country"),
      builder.literal("", STRING_TYPE),
    ),
  );
  return builder.aggregate(
    nonempty,
    { country: builder.slot(nonempty, "country") },
    [{ name: "views", kind: "count-rows" }],
  );
}

function buildRoutePlan(
  input: PerformanceReportInput,
  limit: number,
): ValidatedLogicalPlan {
  if (!Number.isInteger(limit))
    throw new Error("performance_invalid_route_limit");
  const source = createMultiReportSource(input, [
    "page.report.pathname",
    ...PERFORMANCE_METRICS.map(({ attribute }) => `page.report.${attribute}`),
  ]);
  const pages = reportPages(source.builder, source.pages, { path: true });
  const paths = pathViews(source.builder, pages, limit);
  addRouteOutputs(source.builder, pages, paths, "route");
  return source.builder.finish();
}

export function buildPerformanceAllTrendsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly interval: Interval;
}): ValidatedLogicalPlan {
  const source = createMultiReportSource(input, [
    "page.report.startedAt",
    ...PERFORMANCE_METRICS.map(({ attribute }) => `page.report.${attribute}`),
  ]);
  const pages = reportPages(source.builder, source.pages, {
    interval: input.interval,
  });
  addTrendOutputs(source.builder, pages, "trend");
  return source.builder.finish();
}

export function buildPerformanceRoutesPlan(
  input: PerformanceReportInput & { readonly limit: number },
): ValidatedLogicalPlan {
  return buildRoutePlan(input, input.limit);
}

export function buildPerformanceCountriesPlan(
  input: PerformanceReportInput,
): ValidatedLogicalPlan {
  const source = createMultiReportSource(input, [
    "page.report.country",
    ...PERFORMANCE_METRICS.map(({ attribute }) => `page.report.${attribute}`),
  ]);
  const pages = reportPages(source.builder, source.pages, { country: true });
  const views = countryViews(source.builder, pages);
  addCountryOutputs(source.builder, pages, views, "country");
  return source.builder.finish();
}

export function buildPerformanceDashboardPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly interval: Interval;
  readonly routeLimit: number;
}): ValidatedLogicalPlan {
  if (!Number.isInteger(input.routeLimit))
    throw new Error("performance_invalid_route_limit");
  const source = createMultiReportSource(input, [
    "page.report.startedAt",
    "page.report.pathname",
    "page.report.country",
    ...PERFORMANCE_METRICS.map(({ attribute }) => `page.report.${attribute}`),
  ]);
  const pages = reportPages(source.builder, source.pages, {
    interval: input.interval,
    path: true,
    country: true,
  });
  const outputIds: string[] = [];

  for (const { key } of PERFORMANCE_METRICS) {
    const stats = metricStatistics(source.builder, pages, key);
    const nonempty = source.builder.filter(
      stats,
      source.builder.compare(
        "gt",
        source.builder.slot(stats, "samples"),
        source.builder.literal(0, NUMBER_TYPE),
      ),
    );
    outputIds.push(wireMetricOutput(source.builder, "summary", key, nonempty));
  }

  outputIds.push(...addTrendOutputs(source.builder, pages, "trend"));
  const topPaths = pathViews(source.builder, pages, input.routeLimit);
  outputIds.push(...addRouteOutputs(source.builder, pages, topPaths, "route"));
  const views = countryViews(source.builder, pages);
  outputIds.push(...addCountryOutputs(source.builder, pages, views, "country"));
  return source.builder.finish();
}
