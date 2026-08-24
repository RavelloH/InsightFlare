import {
  compareMetricProjections,
  projectComparisonMetrics,
} from "./comparison-metrics";
import type {
  AnalyticsResult,
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
} from "./types";

export type ComparisonSide = "current" | "reference";

export interface ComparisonProviderInput<Query> {
  readonly side: ComparisonSide;
  readonly context: QueryContext;
  readonly query: ComparisonDatasetQuery;
  readonly comparison: Query;
  readonly signal?: AbortSignal;
}

export type ComparisonProvider<Result, Query> = (
  input: ComparisonProviderInput<Query>,
) => Promise<AnalyticsResult<Result>>;

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

function combineMeta<T>(
  current: AnalyticsResult<T> & { readonly ok: true },
  reference: AnalyticsResult<T> & { readonly ok: true },
) {
  return {
    time: current.meta.time,
    source:
      current.meta.source === reference.meta.source
        ? current.meta.source
        : ("mixed" as const),
    approximateVisitors:
      current.meta.approximateVisitors || reference.meta.approximateVisitors,
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
): Promise<AnalyticsResult<ComparisonResult>> {
  const [current, reference] = await both(query, provider, signal);
  if (!current.ok) return current;
  if (!reference.ok) return reference;
  return {
    ok: true,
    data: compareMetrics(current.data, reference.data, query.metrics),
    meta: combineMeta(current, reference),
  };
}

export async function executeComparisonTrend(
  query: ComparisonTrendQuery,
  provider: ComparisonProvider<ComparisonRawTrendResult, ComparisonTrendQuery>,
  signal?: AbortSignal,
): Promise<AnalyticsResult<ComparisonTrendResult>> {
  const [current, reference] = await both(query, provider, signal);
  if (!current.ok) return current;
  if (!reference.ok) return reference;
  if (
    current.data.points.length !== reference.data.points.length ||
    current.data.interval !== reference.data.interval
  ) {
    return {
      ok: false,
      error: { kind: "comparison-alignment-mismatch" },
    };
  }
  return {
    ok: true,
    data: {
      interval: current.data.interval,
      points: current.data.points.map((point, index) => {
        const other = reference.data.points[index]!;
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
    meta: combineMeta(current, reference),
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
): Promise<AnalyticsResult<ComparisonBreakdownResult>> {
  const [current, reference] = await both(query, provider, signal);
  if (!current.ok) return current;
  if (!reference.ok) return reference;
  const currentByKey = new Map(
    current.data.items.map((item) => [item.key, item]),
  );
  const referenceByKey = new Map(
    reference.data.items.map((item) => [item.key, item]),
  );
  const keys = [
    ...new Set([
      ...current.data.items.map((item) => item.key),
      ...reference.data.items.map((item) => item.key),
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
    ok: true,
    data: {
      items: items.slice(0, query.limit),
      complete: current.data.complete && reference.data.complete,
    },
    meta: combineMeta(current, reference),
  };
}
