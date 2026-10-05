import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  Interval,
  PerformanceMetricKey,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const PERFORMANCE_SUMMARY_OUTPUT_ID = "performance-summaries";
export const PERFORMANCE_TREND_OUTPUT_ID = "performance-trend";

const METRICS = [
  { key: "ttfb", attribute: "perfTtfbMs" },
  { key: "fcp", attribute: "perfFcpMs" },
  { key: "lcp", attribute: "perfLcpMs" },
  { key: "cls", attribute: "perfCls" },
  { key: "inp", attribute: "perfInpMs" },
] as const satisfies readonly {
  readonly key: PerformanceMetricKey;
  readonly attribute: string;
}[];

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
      [
        { name: "p50", percentile: 50 },
        { name: "p75", percentile: 75 },
        { name: "p95", percentile: 95 },
      ],
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
    [
      { name: "p50", percentile: 50 },
      { name: "p75", percentile: 75 },
      { name: "p95", percentile: 95 },
    ],
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
