import {
  PERFORMANCE_METRIC_COLUMNS,
  type PerformanceMetricKey,
  type PerformanceRouteMetricRow,
  type VisitPerformanceMetricsRow,
} from "./core-types";

export function performanceMetricColumn(metric: PerformanceMetricKey): string {
  return PERFORMANCE_METRIC_COLUMNS[metric];
}

export function roundPerformanceValue(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 1000) / 1000;
}

export function nullablePerformanceValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 1000) / 1000;
}

export function emptyVisitPerformanceMetrics(): VisitPerformanceMetricsRow {
  return {
    ttfb: null,
    fcp: null,
    lcp: null,
    cls: null,
    inp: null,
  };
}

export function mapVisitPerformanceMetrics(
  row: Record<string, unknown>,
): VisitPerformanceMetricsRow {
  return {
    ttfb: nullablePerformanceValue(row.perfTtfbMs),
    fcp: nullablePerformanceValue(row.perfFcpMs),
    lcp: nullablePerformanceValue(row.perfLcpMs),
    cls: nullablePerformanceValue(row.perfCls),
    inp: nullablePerformanceValue(row.perfInpMs),
  };
}

export function emptyPerformanceRouteMetric(): PerformanceRouteMetricRow {
  return {
    avg: null,
    p50: null,
    p75: null,
    p95: null,
    samples: 0,
  };
}

export function emptyPerformanceRouteMetrics(): Record<
  PerformanceMetricKey,
  PerformanceRouteMetricRow
> {
  return {
    ttfb: emptyPerformanceRouteMetric(),
    fcp: emptyPerformanceRouteMetric(),
    lcp: emptyPerformanceRouteMetric(),
    cls: emptyPerformanceRouteMetric(),
    inp: emptyPerformanceRouteMetric(),
  };
}
