import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiPulseLine,
} from "@remixicon/react";

import { type PerformanceTrendChartPoint } from "@/components/dashboard/charts/performance-trend-chart";
import { type CountryFeature } from "@/components/dashboard/site-pages/performance/performance-map-utils";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  PerformanceCountrySummary,
  PerformanceData,
  PerformanceMetricKey,
  PerformanceRouteMetricSummary,
  PerformanceRouteSummary,
  PerformanceSummary,
  PerformanceTrendPoint,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
export interface PerformanceClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}
export type PerformancePanelKey = PerformanceMetricKey | "score";
export type PerformanceStatus = "great" | "needs-improvement" | "poor" | "none";
export type PathSortKey = "samples" | "value" | "score";
export type SortDirection = "asc" | "desc";
export interface MetricCardModel {
  key: PerformancePanelKey;
  label: string;
  valueLabel: string;
  value: number | null;
  summary: PerformanceSummary;
  status: PerformanceStatus;
  score: number | null;
  comparisonValue: number | null;
  changeRate: number | null;
}
export interface PathPerformanceRow {
  key: string;
  pathname: string;
  views: number;
  samples: number;
  value: number | null;
  score: number | null;
  status: PerformanceStatus;
  comparisonViews: number;
  comparisonSamples: number;
  comparisonValue: number | null;
  comparisonScore: number | null;
  comparisonStatus: PerformanceStatus;
}
export interface CountryHealthRow {
  key: string;
  country: string;
  label: string;
  iconName: string | null;
  views: number;
  samples: number;
  value: number | null;
  score: number | null;
  status: PerformanceStatus;
  comparisonViews: number;
  comparisonSamples: number;
  comparisonValue: number | null;
  comparisonScore: number | null;
  comparisonStatus: PerformanceStatus;
}
export interface CountryMapHover {
  key: string;
  label: string;
  samples: number;
  score: number | null;
  status: PerformanceStatus;
}
export interface PerformanceMapFeature {
  code: string | null;
  feature: CountryFeature;
  hoverKey: string;
  path: string;
}
type ChartPoint = PerformanceTrendChartPoint;
const PERFORMANCE_METRICS: PerformanceMetricKey[] = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "inp",
];
export const PERFORMANCE_PANELS: PerformancePanelKey[] = [
  "score",
  ...PERFORMANCE_METRICS,
];
export const EMPTY_SUMMARY: PerformanceSummary = {
  avg: null,
  p50: null,
  p75: null,
  p95: null,
  samples: 0,
};
const EMPTY_ROUTE_METRIC_SUMMARY: PerformanceRouteMetricSummary = {
  avg: null,
  p50: null,
  p75: null,
  p95: null,
  samples: 0,
};
export const METRIC_THRESHOLDS: Record<
  PerformanceMetricKey,
  { good: number; poor: number }
> = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};
export const STATUS_STYLE: Record<
  PerformanceStatus,
  {
    labelClassName: string;
    softClassName: string;
    icon: typeof RiCheckboxCircleFill;
  }
> = {
  great: {
    labelClassName: "text-chart-4",
    softClassName: "bg-chart-4/10 text-chart-4",
    icon: RiCheckboxCircleFill,
  },
  "needs-improvement": {
    labelClassName: "text-[oklch(0.75_0.16_80)]",
    softClassName: "bg-[oklch(0.75_0.16_80_/_0.12)] text-[oklch(0.75_0.16_80)]",
    icon: RiErrorWarningFill,
  },
  poor: {
    labelClassName: "text-destructive",
    softClassName: "bg-destructive/10 text-destructive",
    icon: RiCloseCircleFill,
  },
  none: {
    labelClassName: "text-muted-foreground",
    softClassName: "bg-muted text-muted-foreground",
    icon: RiPulseLine,
  },
};
export function emptyPerformance(
  interval: TimeWindow["interval"],
): PerformanceData {
  return {
    ok: true,
    interval,
    summaries: {
      ttfb: { ...EMPTY_SUMMARY },
      fcp: { ...EMPTY_SUMMARY },
      lcp: { ...EMPTY_SUMMARY },
      cls: { ...EMPTY_SUMMARY },
      inp: { ...EMPTY_SUMMARY },
    },
    trends: {
      ttfb: [],
      fcp: [],
      lcp: [],
      cls: [],
      inp: [],
    },
    routes: [],
    countries: [],
  };
}
function intervalStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60_000;
  if (interval === "hour") return 60 * 60_000;
  if (interval === "day") return 24 * 60 * 60_000;
  if (interval === "week") return 7 * 24 * 60 * 60_000;
  return 30 * 24 * 60 * 60_000;
}
function metricLabel(
  messages: AppMessages,
  metric: PerformanceMetricKey,
): string {
  return messages.performance[metric];
}
export function panelLabel(
  messages: AppMessages,
  key: PerformancePanelKey,
): string {
  return key === "score"
    ? messages.performance.score
    : metricLabel(messages, key);
}
export function metricDescription(
  messages: AppMessages,
  key: PerformancePanelKey,
): string {
  if (key === "score") return messages.performance.scoreDescription;
  return messages.performance[`${key}Description`];
}
export function statusLabel(
  messages: AppMessages,
  status: PerformanceStatus,
): string {
  if (status === "great") return messages.performance.great;
  if (status === "needs-improvement") {
    return messages.performance.needsImprovement;
  }
  if (status === "poor") return messages.performance.poor;
  return messages.common.noData;
}
export function scoreStatus(
  score: number | null | undefined,
): PerformanceStatus {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 90) return "great";
  if (score >= 50) return "needs-improvement";
  return "poor";
}
export function metricStatus(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): PerformanceStatus {
  if (value == null || !Number.isFinite(value)) return "none";
  const thresholds = METRIC_THRESHOLDS[metric];
  if (value <= thresholds.good) return "great";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}
export function metricScore(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const thresholds = METRIC_THRESHOLDS[metric];
  if (value <= thresholds.good) {
    const ratio = thresholds.good > 0 ? value / thresholds.good : 0;
    return Math.max(90, Math.min(100, 100 - ratio * 10));
  }
  if (value <= thresholds.poor) {
    const ratio =
      (value - thresholds.good) / (thresholds.poor - thresholds.good);
    return Math.max(50, Math.min(90, 90 - ratio * 40));
  }

  const poorWindow = Math.max(
    thresholds.poor - thresholds.good,
    thresholds.poor,
    1,
  );
  const ratio = (value - thresholds.poor) / poorWindow;
  return Math.max(0, Math.min(50, 50 - ratio * 50));
}
function averageScore(values: Array<number | null | undefined>): number | null {
  const scores = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}
export function roundedScore(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  return Math.round(score);
}
export function scoreSummary(data: PerformanceData): PerformanceSummary {
  const scoreForPercentile = (
    percentile: keyof Pick<PerformanceSummary, "avg" | "p50" | "p75" | "p95">,
  ) =>
    averageScore(
      PERFORMANCE_METRICS.map((metric) =>
        metricScore(metric, data.summaries[metric]?.[percentile]),
      ),
    );

  return {
    avg: scoreForPercentile("avg"),
    p50: scoreForPercentile("p50"),
    p75: scoreForPercentile("p75"),
    p95: scoreForPercentile("p95"),
    samples: Math.max(
      0,
      ...PERFORMANCE_METRICS.map(
        (metric) => data.summaries[metric]?.samples ?? 0,
      ),
    ),
  };
}
function routeMetric(
  route: PerformanceRouteSummary,
  metric: PerformanceMetricKey,
): PerformanceRouteMetricSummary {
  return route.metrics[metric] ?? EMPTY_ROUTE_METRIC_SUMMARY;
}
export function routeScore(route: PerformanceRouteSummary): number | null {
  return averageScore(
    PERFORMANCE_METRICS.map((metric) =>
      metricScore(metric, routeMetric(route, metric).p75),
    ),
  );
}
export function routeSamples(
  route: PerformanceRouteSummary,
  key: PerformancePanelKey,
): number {
  if (key !== "score") return routeMetric(route, key).samples ?? 0;
  return Math.max(
    0,
    ...PERFORMANCE_METRICS.map(
      (metric) => routeMetric(route, metric).samples ?? 0,
    ),
  );
}
export function routeValue(
  route: PerformanceRouteSummary,
  key: PerformancePanelKey,
): number | null {
  if (key === "score") return routeScore(route);
  return routeMetric(route, key).p75;
}
export function routeStatus(
  route: PerformanceRouteSummary,
  key: PerformancePanelKey,
): PerformanceStatus {
  const value = routeValue(route, key);
  if (key === "score") return scoreStatus(value);
  return metricStatus(key, value);
}
function countryMetric(
  country: PerformanceCountrySummary,
  metric: PerformanceMetricKey,
): PerformanceRouteMetricSummary {
  return country.metrics[metric] ?? EMPTY_ROUTE_METRIC_SUMMARY;
}
export function countryScore(
  country: PerformanceCountrySummary,
): number | null {
  return averageScore(
    PERFORMANCE_METRICS.map((metric) =>
      metricScore(metric, countryMetric(country, metric).p75),
    ),
  );
}
export function countrySamples(
  country: PerformanceCountrySummary,
  key: PerformancePanelKey,
): number {
  if (key !== "score") return countryMetric(country, key).samples ?? 0;
  return Math.max(
    0,
    ...PERFORMANCE_METRICS.map(
      (metric) => countryMetric(country, metric).samples ?? 0,
    ),
  );
}
export function countryValue(
  country: PerformanceCountrySummary,
  key: PerformancePanelKey,
): number | null {
  if (key === "score") return countryScore(country);
  return countryMetric(country, key).p75;
}
export function countryStatus(
  country: PerformanceCountrySummary,
  key: PerformancePanelKey,
): PerformanceStatus {
  const value = countryValue(country, key);
  if (key === "score") return scoreStatus(value);
  return metricStatus(key, value);
}
export function formatMetricValue(
  locale: Locale,
  messages: AppMessages,
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (metric === "cls") {
    const formatted = new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 3,
    }).format(value);
    return `${formatted} ${messages.performance.clsUnit}`;
  }
  if (metric === "inp") {
    return `${numberFormat(locale, Math.round(value))} ${messages.performance.msUnit}`;
  }
  const seconds = value / 1000;
  const formatted = new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 2,
    minimumFractionDigits: seconds < 10 ? 2 : 1,
  }).format(seconds);
  return `${formatted} ${messages.performance.secondsUnit}`;
}
export function formatPanelValue(
  locale: Locale,
  messages: AppMessages,
  key: PerformancePanelKey,
  value: number | null | undefined,
): string {
  if (key === "score") {
    const score = roundedScore(value);
    return score == null ? "--" : numberFormat(locale, score);
  }
  return formatMetricValue(locale, messages, key, value);
}
export function performanceChangeRate(
  current: number | null | undefined,
  comparison: number | null | undefined,
): number | null {
  if (
    current == null ||
    comparison == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(comparison) ||
    comparison === 0
  ) {
    return null;
  }
  return ((current - comparison) / comparison) * 100;
}
export function PerformanceChangeRate({
  value,
  activePanel,
}: {
  value: number | null;
  activePanel: PerformancePanelKey;
}) {
  if (value == null || !Number.isFinite(value)) return null;

  const improved = activePanel === "score" ? value >= 0 : value <= 0;
  const ChangeIcon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none tabular-nums",
        improved ? "text-emerald-600" : "text-rose-600",
      )}
    >
      <ChangeIcon className="size-3.5" />
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}
export function statusColor(status: PerformanceStatus): string {
  if (status === "great") return "var(--color-chart-4)";
  if (status === "needs-improvement") return "oklch(0.75 0.16 80)";
  if (status === "poor") return "var(--color-destructive)";
  return "var(--color-muted-foreground)";
}
function normalizedSegmentWidths(
  segments: Array<{
    status: Exclude<PerformanceStatus, "none">;
    width: number;
  }>,
): Array<{
  status: Exclude<PerformanceStatus, "none">;
  width: number;
}> {
  const total = segments.reduce((sum, segment) => sum + segment.width, 0);
  if (total <= 0) return segments.map((segment) => ({ ...segment, width: 0 }));
  return segments.map((segment) => ({
    ...segment,
    width: Math.max(0, Math.min(100, (segment.width / total) * 100)),
  }));
}
function percentileAtThreshold(
  anchors: Array<{ percentile: number; value: number }>,
  threshold: number,
): number {
  if (anchors.length === 0) return 0;

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const descending = first.value > last.value;
  if (!descending && threshold <= first.value) return first.percentile;
  if (!descending && threshold >= last.value) return last.percentile;
  if (descending && threshold >= first.value) return first.percentile;
  if (descending && threshold <= last.value) return last.percentile;

  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    const min = Math.min(previous.value, current.value);
    const max = Math.max(previous.value, current.value);
    if (threshold < min || threshold > max) continue;
    if (previous.value === current.value) return current.percentile;
    const ratio =
      (threshold - previous.value) / (current.value - previous.value);
    return Math.max(
      0,
      Math.min(
        100,
        previous.percentile +
          ratio * (current.percentile - previous.percentile),
      ),
    );
  }

  return last.percentile;
}
function metricDistributionMax(
  key: PerformanceMetricKey,
  summary: PerformanceSummary,
): number {
  const thresholds = METRIC_THRESHOLDS[key];
  const observedMax = Math.max(
    thresholds.poor,
    summary.p50 ?? 0,
    summary.p75 ?? 0,
    summary.p95 ?? 0,
    summary.avg ?? 0,
  );
  if (key === "cls") return Math.max(0.3, observedMax * 1.15);
  return Math.max(thresholds.poor * 1.2, observedMax * 1.15);
}
export function railSegments(
  key: PerformancePanelKey,
  summary: PerformanceSummary,
): Array<{
  status: Exclude<PerformanceStatus, "none">;
  width: number;
}> {
  if (summary.samples <= 0 || summary.p75 == null) {
    return [
      { status: "great", width: 0 },
      { status: "needs-improvement", width: 0 },
      { status: "poor", width: 0 },
    ];
  }

  if (key === "score") {
    const anchors = [
      { percentile: 0, value: 100 },
      { percentile: 50, value: summary.p50 ?? summary.p75 },
      { percentile: 75, value: summary.p75 },
      { percentile: 95, value: summary.p95 ?? summary.p75 },
      { percentile: 100, value: 0 },
    ].map((anchor, index, list) => ({
      ...anchor,
      value:
        index === 0
          ? anchor.value
          : Math.min(list[index - 1]?.value ?? 100, Math.max(0, anchor.value)),
    }));
    const greatEnd = percentileAtThreshold(anchors, 90);
    const needsEnd = percentileAtThreshold(anchors, 50);
    return normalizedSegmentWidths([
      { status: "great", width: greatEnd },
      { status: "needs-improvement", width: Math.max(0, needsEnd - greatEnd) },
      { status: "poor", width: Math.max(0, 100 - needsEnd) },
    ]);
  }

  const thresholds = METRIC_THRESHOLDS[key];
  const anchors = [
    { percentile: 0, value: 0 },
    { percentile: 50, value: summary.p50 ?? summary.p75 },
    { percentile: 75, value: summary.p75 },
    { percentile: 95, value: summary.p95 ?? summary.p75 },
    { percentile: 100, value: metricDistributionMax(key, summary) },
  ].map((anchor, index, list) => ({
    ...anchor,
    value:
      index === 0
        ? anchor.value
        : Math.max(list[index - 1]?.value ?? 0, anchor.value),
  }));
  const greatEnd = percentileAtThreshold(anchors, thresholds.good);
  const needsEnd = percentileAtThreshold(anchors, thresholds.poor);
  return [
    { status: "great", width: greatEnd },
    { status: "needs-improvement", width: Math.max(0, needsEnd - greatEnd) },
    { status: "poor", width: Math.max(0, 100 - needsEnd) },
  ];
}
export function buildScoreTrend(
  performanceData: PerformanceData,
  dataWindow: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): ChartPoint[] {
  const metricMaps = new Map<
    PerformanceMetricKey,
    Map<number, PerformanceTrendPoint>
  >();

  for (const metric of PERFORMANCE_METRICS) {
    metricMaps.set(
      metric,
      new Map(
        (performanceData.trends[metric] ?? []).map((point) => [
          startOfZonedInterval(
            Number(point.timestampMs ?? 0),
            dataWindow.interval,
            dataWindow.timeZone,
          ),
          point,
        ]),
      ),
    );
  }

  const startBucket = startOfZonedInterval(
    dataWindow.from,
    dataWindow.interval,
    dataWindow.timeZone,
  );
  const endBucket = startOfZonedInterval(
    dataWindow.to,
    dataWindow.interval,
    dataWindow.timeZone,
  );
  const rows: ChartPoint[] = [];

  const hardLimit = 2000;
  for (
    let index = 0, bucket = startBucket;
    index < hardLimit && bucket <= endBucket;
    index += 1
  ) {
    const metricPoints = PERFORMANCE_METRICS.map((metric) => ({
      metric,
      point: metricMaps.get(metric)?.get(bucket),
    }));
    rows.push({
      timestampMs: bucket,
      p50: averageScore(
        metricPoints.map(({ metric, point }) =>
          metricScore(metric, point?.p50),
        ),
      ),
      p75: averageScore(
        metricPoints.map(({ metric, point }) =>
          metricScore(metric, point?.p75),
        ),
      ),
      p95: averageScore(
        metricPoints.map(({ metric, point }) =>
          metricScore(metric, point?.p95),
        ),
      ),
      avg: averageScore(
        metricPoints.map(({ metric, point }) =>
          metricScore(metric, point?.avg),
        ),
      ),
      samples: Math.max(
        0,
        ...metricPoints.map(({ point }) => point?.samples ?? 0),
      ),
    });
    let next = addZonedInterval(
      bucket,
      dataWindow.interval,
      dataWindow.timeZone,
    );
    if (!Number.isFinite(next) || next <= bucket) {
      next = bucket + intervalStepMs(dataWindow.interval);
    }
    bucket = next;
  }

  return rows;
}
export function buildMetricTrend(
  performanceData: PerformanceData,
  key: PerformanceMetricKey,
  dataWindow: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): ChartPoint[] {
  const rows = performanceData.trends[key] ?? [];
  const byBucket = new Map(
    rows.map((row) => [
      startOfZonedInterval(
        Number(row.timestampMs ?? 0),
        dataWindow.interval,
        dataWindow.timeZone,
      ),
      row,
    ]),
  );
  const startBucket = startOfZonedInterval(
    dataWindow.from,
    dataWindow.interval,
    dataWindow.timeZone,
  );
  const endBucket = startOfZonedInterval(
    dataWindow.to,
    dataWindow.interval,
    dataWindow.timeZone,
  );
  const filled: ChartPoint[] = [];

  const hardLimit = 2000;
  for (
    let index = 0, bucket = startBucket;
    index < hardLimit && bucket <= endBucket;
    index += 1
  ) {
    const row = byBucket.get(bucket);
    filled.push({
      timestampMs: bucket,
      p50: row?.p50 ?? null,
      p75: row?.p75 ?? null,
      p95: row?.p95 ?? null,
      avg: row?.avg ?? null,
      samples: row?.samples ?? 0,
    });
    let next = addZonedInterval(
      bucket,
      dataWindow.interval,
      dataWindow.timeZone,
    );
    if (!Number.isFinite(next) || next <= bucket) {
      next = bucket + intervalStepMs(dataWindow.interval);
    }
    bucket = next;
  }

  return filled;
}
export function alignComparisonTrend(
  currentPoints: ReadonlyArray<ChartPoint>,
  comparisonPoints: ReadonlyArray<ChartPoint>,
): ChartPoint[] {
  return currentPoints.map((point, index) => {
    const comparisonPoint = comparisonPoints[index];
    return (
      comparisonPoint ?? {
        timestampMs: point.timestampMs,
        p50: null,
        p75: null,
        p95: null,
        avg: null,
        samples: 0,
      }
    );
  });
}
const PERFORMANCE_TABLE_SKELETON_ROWS = 4;
export const PATH_TABLE_SKELETON_ROWS: PathPerformanceRow[] = Array.from(
  { length: PERFORMANCE_TABLE_SKELETON_ROWS },
  (_, index) => ({
    key: `performance-path-skeleton-${index}`,
    pathname: "",
    views: 0,
    samples: 0,
    value: null,
    score: null,
    status: "none",
    comparisonViews: 0,
    comparisonSamples: 0,
    comparisonValue: null,
    comparisonScore: null,
    comparisonStatus: "none",
  }),
);
export const COUNTRY_TABLE_SKELETON_ROWS: CountryHealthRow[] = Array.from(
  { length: PERFORMANCE_TABLE_SKELETON_ROWS },
  (_, index) => ({
    key: `performance-country-skeleton-${index}`,
    country: "",
    label: "",
    iconName: null,
    views: 0,
    samples: 0,
    value: null,
    score: null,
    status: "none",
    comparisonViews: 0,
    comparisonSamples: 0,
    comparisonValue: null,
    comparisonScore: null,
    comparisonStatus: "none",
  }),
);
