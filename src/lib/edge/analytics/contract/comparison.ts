import {
  compareMetricProjections,
  projectComparisonMetrics,
} from "./comparison-metrics";
import type {
  AnalyticsDomainError,
  ComparisonBreakdownItem,
  ComparisonBreakdownQuery,
  ComparisonBreakdownResult,
  ComparisonDatasetQuery,
  ComparisonMetricKey,
  ComparisonRawBreakdownResult,
  ComparisonRawMetrics,
  ComparisonRawTrendResult,
  ComparisonResult,
  ComparisonTrendQuery,
  ComparisonTrendResult,
  QueryContext,
  QuerySource,
} from "./types";

export type ComparisonSide = "current" | "reference";

export interface ComparisonProviderInput<Query> {
  readonly side: ComparisonSide;
  readonly context: QueryContext;
  readonly query: ComparisonDatasetQuery;
  readonly comparison: Query;
  readonly signal?: AbortSignal;
}

export interface ComparisonProviderResult<Result> {
  readonly value: Result;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

export class ComparisonDomainError extends Error {
  constructor(readonly domainError: AnalyticsDomainError) {
    super(domainError.kind);
    this.name = "ComparisonDomainError";
  }
}

export type ComparisonProvider<Result, Query> = (
  input: ComparisonProviderInput<Query>,
) => Promise<ComparisonProviderResult<Result>>;

function compareMetrics(
  current: ComparisonRawMetrics,
  reference: ComparisonRawMetrics,
  metrics: readonly ComparisonMetricKey[],
): ComparisonResult {
  const currentProjection = projectComparisonMetrics(current, metrics);
  const referenceProjection = projectComparisonMetrics(reference, metrics);
  return {
    current: currentProjection,
    reference: referenceProjection,
    change: compareMetricProjections(
      currentProjection,
      referenceProjection,
      metrics,
    ),
  };
}

function combineProvenance<T>(
  current: ComparisonProviderResult<T>,
  reference: ComparisonProviderResult<T>,
) {
  return {
    source:
      current.source === reference.source ? current.source : ("mixed" as const),
    approximateVisitors:
      current.approximateVisitors || reference.approximateVisitors,
  };
}

async function both<Result, Query>(
  query: Query & {
    readonly context: QueryContext;
    readonly current: ComparisonDatasetQuery;
    readonly reference: ComparisonDatasetQuery;
  },
  provider: ComparisonProvider<Result, Query>,
  signal?: AbortSignal,
) {
  return Promise.all([
    provider({
      side: "current",
      context: query.context,
      query: query.current,
      comparison: query,
      signal,
    }),
    provider({
      side: "reference",
      context: query.context,
      query: query.reference,
      comparison: query,
      signal,
    }),
  ]);
}

export async function executeComparison(
  query: {
    readonly context: QueryContext;
    readonly current: ComparisonDatasetQuery;
    readonly reference: ComparisonDatasetQuery;
    readonly metrics: readonly ComparisonMetricKey[];
  },
  provider: ComparisonProvider<ComparisonRawMetrics, typeof query>,
  signal?: AbortSignal,
): Promise<ComparisonProviderResult<ComparisonResult>> {
  const [current, reference] = await both(query, provider, signal);
  return {
    value: compareMetrics(current.value, reference.value, query.metrics),
    ...combineProvenance(current, reference),
  };
}

export async function executeComparisonTrend(
  query: ComparisonTrendQuery,
  provider: ComparisonProvider<ComparisonRawTrendResult, ComparisonTrendQuery>,
  signal?: AbortSignal,
): Promise<ComparisonProviderResult<ComparisonTrendResult>> {
  const [current, reference] = await both(query, provider, signal);
  if (
    current.value.points.length !== reference.value.points.length ||
    current.value.interval !== reference.value.interval
  ) {
    throw new ComparisonDomainError({ kind: "comparison-alignment-mismatch" });
  }
  return {
    value: {
      interval: current.value.interval,
      points: current.value.points.map((point, index) => {
        const other = reference.value.points[index]!;
        const compared = compareMetrics(point, other, query.trendMetrics);
        return {
          index,
          current: {
            fromMs: point.fromMs,
            toMs: point.toMs,
            metrics: compared.current,
          },
          reference: {
            fromMs: other.fromMs,
            toMs: other.toMs,
            metrics: compared.reference,
          },
          change: compared.change,
        };
      }),
    },
    ...combineProvenance(current, reference),
  };
}

function sortValue(
  item: ComparisonBreakdownItem,
  by: ComparisonBreakdownQuery["sort"]["by"],
): number | string | null {
  if (by === "key") return item.key;
  const [group, metric, change] = by.split(".");
  if (group === "current" || group === "reference") {
    return item[group][metric as ComparisonMetricKey] ?? null;
  }
  if (group === "change" && metric && change) {
    return (
      item.change[metric as ComparisonMetricKey]?.[
        change as "absolute" | "relative"
      ] ?? null
    );
  }
  return null;
}

function compareBreakdownItems(
  left: ComparisonBreakdownItem,
  right: ComparisonBreakdownItem,
  query: ComparisonBreakdownQuery,
): number {
  const leftValue = sortValue(left, query.sort.by);
  const rightValue = sortValue(right, query.sort.by);
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue === null) return -1;
  let result = 0;
  if (typeof leftValue === "string" && typeof rightValue === "string") {
    result = leftValue.localeCompare(rightValue);
  } else if (typeof leftValue === "number" && typeof rightValue === "number") {
    result = leftValue - rightValue;
  }
  if (result !== 0) {
    return query.sort.direction === "desc" ? -result : result;
  }
  return left.key.localeCompare(right.key);
}

function emptyRawMetrics(): ComparisonRawMetrics {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    durationViews: 0,
    events: 0,
  };
}

export async function executeComparisonBreakdown(
  query: ComparisonBreakdownQuery,
  provider: ComparisonProvider<
    ComparisonRawBreakdownResult,
    ComparisonBreakdownQuery
  >,
  signal?: AbortSignal,
): Promise<ComparisonProviderResult<ComparisonBreakdownResult>> {
  const [current, reference] = await both(query, provider, signal);
  const currentByKey = new Map(
    current.value.items.map((item) => [item.key, item]),
  );
  const referenceByKey = new Map(
    reference.value.items.map((item) => [item.key, item]),
  );
  const keys = [
    ...new Set([
      ...current.value.items.map((item) => item.key),
      ...reference.value.items.map((item) => item.key),
    ]),
  ];
  const items: ComparisonBreakdownItem[] = keys.map((key) => {
    const currentItem = currentByKey.get(key);
    const referenceItem = referenceByKey.get(key);
    const compared = compareMetrics(
      currentItem ?? emptyRawMetrics(),
      referenceItem ?? emptyRawMetrics(),
      ["views", "sessions", "visitors"],
    );
    return {
      key,
      label: currentItem?.label ?? referenceItem!.label,
      current: compared.current,
      reference: compared.reference,
      change: compared.change,
    };
  });
  items.sort((left, right) => compareBreakdownItems(left, right, query));
  return {
    value: {
      items: items.slice(0, query.limit),
      complete: current.value.complete && reference.value.complete,
    },
    ...combineProvenance(current, reference),
  };
}
