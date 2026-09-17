import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Icon } from "@iconify/react";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiMapPin2Line,
  RiPulseLine,
  RiRouteLine,
  RiSpeedUpLine,
} from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";

import {
  PerformanceTrendChart,
  type PerformanceTrendChartLabels,
  type PerformanceTrendChartPoint,
} from "@/components/dashboard/charts/performance-trend-chart";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  type CountriesFeatureCollection,
  type CountryFeature,
  countryFillOpacity,
  geometryToPath,
  normalizeCountryCode,
  resolveCountryCodeFromFeature,
  resolveCountryLabelFromFeature,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
} from "@/components/dashboard/site-pages/performance-map-utils";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableSortState,
} from "@/components/dashboard/tabbed-data-table-card";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { fetchPerformance } from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type {
  PerformanceCountrySummary,
  PerformanceData,
  PerformanceMetricKey,
  PerformanceRouteMetricSummary,
  PerformanceRouteSummary,
  PerformanceSummary,
  PerformanceTrendPoint,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

interface PerformanceClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}

type PerformancePanelKey = PerformanceMetricKey | "score";
type PerformanceStatus = "great" | "needs-improvement" | "poor" | "none";
type PathSortKey = "samples" | "value" | "score";
type SortDirection = "asc" | "desc";

interface MetricCardModel {
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

interface PathPerformanceRow {
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

interface CountryHealthRow {
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

interface CountryMapHover {
  key: string;
  label: string;
  samples: number;
  score: number | null;
  status: PerformanceStatus;
}

interface PerformanceMapFeature {
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

const PERFORMANCE_PANELS: PerformancePanelKey[] = [
  "score",
  ...PERFORMANCE_METRICS,
];

const EMPTY_SUMMARY: PerformanceSummary = {
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

const METRIC_THRESHOLDS: Record<
  PerformanceMetricKey,
  { good: number; poor: number }
> = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};

const STATUS_STYLE: Record<
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

function emptyPerformance(interval: TimeWindow["interval"]): PerformanceData {
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

function panelLabel(messages: AppMessages, key: PerformancePanelKey): string {
  return key === "score"
    ? messages.performance.score
    : metricLabel(messages, key);
}

function metricDescription(
  messages: AppMessages,
  key: PerformancePanelKey,
): string {
  if (key === "score") return messages.performance.scoreDescription;
  return messages.performance[`${key}Description`];
}

function statusLabel(messages: AppMessages, status: PerformanceStatus): string {
  if (status === "great") return messages.performance.great;
  if (status === "needs-improvement") {
    return messages.performance.needsImprovement;
  }
  if (status === "poor") return messages.performance.poor;
  return messages.common.noData;
}

function scoreStatus(score: number | null | undefined): PerformanceStatus {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 90) return "great";
  if (score >= 50) return "needs-improvement";
  return "poor";
}

function metricStatus(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): PerformanceStatus {
  if (value == null || !Number.isFinite(value)) return "none";
  const thresholds = METRIC_THRESHOLDS[metric];
  if (value <= thresholds.good) return "great";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}

function metricScore(
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

function roundedScore(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  return Math.round(score);
}

function scoreSummary(data: PerformanceData): PerformanceSummary {
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

function routeScore(route: PerformanceRouteSummary): number | null {
  return averageScore(
    PERFORMANCE_METRICS.map((metric) =>
      metricScore(metric, routeMetric(route, metric).p75),
    ),
  );
}

function routeSamples(
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

function routeValue(
  route: PerformanceRouteSummary,
  key: PerformancePanelKey,
): number | null {
  if (key === "score") return routeScore(route);
  return routeMetric(route, key).p75;
}

function routeStatus(
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

function countryScore(country: PerformanceCountrySummary): number | null {
  return averageScore(
    PERFORMANCE_METRICS.map((metric) =>
      metricScore(metric, countryMetric(country, metric).p75),
    ),
  );
}

function countrySamples(
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

function countryValue(
  country: PerformanceCountrySummary,
  key: PerformancePanelKey,
): number | null {
  if (key === "score") return countryScore(country);
  return countryMetric(country, key).p75;
}

function countryStatus(
  country: PerformanceCountrySummary,
  key: PerformancePanelKey,
): PerformanceStatus {
  const value = countryValue(country, key);
  if (key === "score") return scoreStatus(value);
  return metricStatus(key, value);
}

function formatMetricValue(
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

function formatPanelValue(
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

function performanceChangeRate(
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

function PerformanceChangeRate({
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

function statusColor(status: PerformanceStatus): string {
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

function railSegments(
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

function buildScoreTrend(
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

function buildMetricTrend(
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

function alignComparisonTrend(
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
const PATH_TABLE_SKELETON_ROWS: PathPerformanceRow[] = Array.from(
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
const COUNTRY_TABLE_SKELETON_ROWS: CountryHealthRow[] = Array.from(
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

const PerformanceDynamicValue = memo(function PerformanceDynamicValue({
  children,
  loading,
  skeletonClassName,
  className,
  transitionKey,
}: {
  children: ReactNode;
  loading: boolean;
  skeletonClassName: string;
  className?: string;
  transitionKey?: string | number;
}) {
  return (
    <AutoResizer className={cn("min-w-0", className)} duration={0.2}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : (transitionKey ?? "ready")}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="flex min-h-5 min-w-0 items-center"
      >
        {loading ? (
          <Skeleton key="loading" className={skeletonClassName} />
        ) : (
          <div key="ready" className="min-h-5 min-w-0">
            {children}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});

const PerformancePanelText = memo(function PerformancePanelText({
  children,
  transitionKey,
  className,
  resizerClassName,
  animateWidth = false,
}: {
  children: ReactNode;
  transitionKey: string | number;
  className?: string;
  resizerClassName?: string;
  animateWidth?: boolean;
}) {
  return (
    <AutoResizer
      className={cn("min-w-0", resizerClassName)}
      duration={0.2}
      animateWidth={animateWidth}
      animateHeight={!animateWidth}
    >
      <AutoTransition
        className={cn("min-w-0", className)}
        initial={false}
        transitionKey={transitionKey}
        duration={0.18}
        type="fade"
        presenceMode="wait"
      >
        {children}
      </AutoTransition>
    </AutoResizer>
  );
});

const PerformanceSpinnerValue = memo(function PerformanceSpinnerValue({
  children,
  loading,
  transitionKey,
}: {
  children: ReactNode;
  loading: boolean;
  transitionKey?: string | number;
}) {
  return (
    <AutoResizer initial animateHeight={false} className="mt-2 h-7">
      <AutoTransition
        className="h-7"
        transitionKey={loading ? "loading" : (transitionKey ?? "ready")}
        initial={false}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <div key="loading" className="flex h-7 items-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div key="ready" className="h-7 min-w-0">
            {children}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});

function PerformanceTrendLoadingState({ messages }: { messages: AppMessages }) {
  const legend = [
    messages.performance.p50Label,
    messages.performance.p75Label,
    messages.performance.p95Label,
  ];

  return (
    <div className="space-y-4">
      <Skeleton className="h-[360px] w-full rounded-none" />
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {legend.map((label) => (
          <span key={label} className="inline-flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-none bg-muted" />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SegmentedThresholdBar({
  panelKey,
  summary,
  status,
  loading = false,
}: {
  panelKey: PerformancePanelKey;
  summary: PerformanceSummary;
  status: PerformanceStatus;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="relative h-5">
        <Skeleton className="absolute inset-x-0 top-1/2 h-2 w-full -translate-y-1/2 rounded-full" />
      </div>
    );
  }

  const marker = summary.p75 == null ? null : 75;
  const segments = railSegments(panelKey, summary);

  return (
    <div className="relative h-5">
      <div className="absolute inset-x-0 top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <div
            key={`${panelKey}-${segment.status}`}
            className="h-full"
            style={{
              width: `${segment.width}%`,
              backgroundColor: statusColor(segment.status),
            }}
          />
        ))}
      </div>
      {marker == null ? null : (
        <span
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
          style={{
            left: `${marker}%`,
            backgroundColor: statusColor(status),
          }}
        />
      )}
    </div>
  );
}

const PerformanceRail = memo(function PerformanceRail({
  activePanel,
  cards,
  onSelect,
  comparisonLabel,
  loading = false,
}: {
  activePanel: PerformancePanelKey;
  cards: MetricCardModel[];
  onSelect: (key: PerformancePanelKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  return (
    <div className="space-y-3 self-start lg:sticky lg:top-[7.5rem]">
      {cards.map((card) => {
        const active = card.key === activePanel;
        const statusStyle = STATUS_STYLE[card.status];
        const StatusIcon = statusStyle.icon;
        return (
          <Clickable
            key={card.key}
            className="block w-full text-left"
            enableHoverScale={false}
            tapScale={0.985}
            aria-label={card.label}
            onClick={() => onSelect(card.key)}
          >
            <div
              className={cn(
                "relative overflow-hidden rounded-none bg-card p-4 ring-1 ring-border/70 transition-all duration-200",
                "hover:bg-muted/35",
              )}
            >
              <div
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary opacity-0 transition-opacity duration-200",
                  active && "opacity-100",
                )}
              />
              <div className="relative space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-muted-foreground">
                      {card.label}
                    </div>
                    <AutoResizer className="mt-2 w-full" duration={0.2}>
                      <PerformanceDynamicValue
                        loading={loading}
                        skeletonClassName="h-8 w-24"
                      >
                        <div className="flex h-8 min-w-0 items-end gap-1.5 leading-none">
                          <div className="min-w-0 truncate text-2xl leading-none font-semibold tracking-tight">
                            {card.valueLabel}
                          </div>
                          {comparisonLabel ? (
                            <PerformanceChangeRate
                              value={card.changeRate}
                              activePanel={card.key}
                            />
                          ) : null}
                        </div>
                      </PerformanceDynamicValue>
                    </AutoResizer>
                  </div>
                  {loading ? (
                    <Skeleton className="size-9 shrink-0 rounded-full" />
                  ) : (
                    <div
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-full",
                        statusStyle.softClassName,
                      )}
                    >
                      <StatusIcon className="size-4" />
                    </div>
                  )}
                </div>
                <SegmentedThresholdBar
                  panelKey={card.key}
                  summary={card.summary}
                  status={card.status}
                  loading={loading}
                />
              </div>
            </div>
          </Clickable>
        );
      })}
    </div>
  );
});

const MetricSummaryCard = memo(function MetricSummaryCard({
  locale,
  messages,
  activePanel,
  activeSummary,
  activeValue,
  comparisonLabel,
  comparisonSummary,
  comparisonValue,
  pathCount,
  comparisonPathCount,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  activeSummary: PerformanceSummary;
  activeValue: number | null;
  comparisonLabel?: string;
  comparisonSummary?: PerformanceSummary | null;
  comparisonValue?: number | null;
  pathCount: number;
  comparisonPathCount?: number;
  loading?: boolean;
}) {
  const activeStatus =
    activePanel === "score"
      ? scoreStatus(activeValue)
      : metricStatus(activePanel, activeValue);
  const statusStyle = STATUS_STYLE[activeStatus];
  const StatusIcon = statusStyle.icon;
  const score =
    activePanel === "score"
      ? activeValue
      : metricScore(activePanel, activeValue);
  const scoreValue = roundedScore(score);
  const displayValue = formatPanelValue(
    locale,
    messages,
    activePanel,
    activeValue,
  );
  const displayComparisonValue = formatPanelValue(
    locale,
    messages,
    activePanel,
    comparisonValue,
  );
  const changeRate = performanceChangeRate(activeValue, comparisonValue);
  const description = metricDescription(messages, activePanel);
  const thresholdText =
    activePanel === "score"
      ? messages.performance.scoreThresholdText
      : formatI18nTemplate(messages.performance.metricThresholdText, {
          good: formatMetricValue(
            locale,
            messages,
            activePanel,
            METRIC_THRESHOLDS[activePanel].good,
          ),
          poor: formatMetricValue(
            locale,
            messages,
            activePanel,
            METRIC_THRESHOLDS[activePanel].poor,
          ),
        });
  const reading =
    activeSummary.samples > 0
      ? formatI18nTemplate(messages.performance.currentReading, {
          metric: panelLabel(messages, activePanel),
          value: displayValue,
          score: scoreValue == null ? "--" : numberFormat(locale, scoreValue),
          samples: numberFormat(locale, activeSummary.samples),
          status: statusLabel(messages, activeStatus),
        })
      : messages.common.noData;
  const ringPercent =
    scoreValue == null ? 0 : Math.max(0, Math.min(100, scoreValue));
  const ringColor = statusColor(activeStatus);
  const activeStatusLabel = statusLabel(messages, activeStatus);

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-5 p-5">
        <AutoResizer className="w-full" duration={0.24}>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <div className="min-w-0">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <PerformancePanelText
                      transitionKey={activePanel}
                      className="text-sm text-muted-foreground"
                    >
                      {panelLabel(messages, activePanel)}
                    </PerformancePanelText>
                    <PerformanceDynamicValue
                      loading={loading}
                      skeletonClassName="h-9 w-24"
                      transitionKey={displayValue}
                    >
                      <div className="flex h-9 items-end gap-2 leading-none">
                        <div className="text-3xl leading-none font-semibold tracking-tight">
                          {displayValue}
                        </div>
                        {comparisonLabel ? (
                          <PerformanceChangeRate
                            value={changeRate}
                            activePanel={activePanel}
                          />
                        ) : null}
                      </div>
                    </PerformanceDynamicValue>
                    {comparisonLabel ? (
                      <PerformancePanelText
                        transitionKey={`${activePanel}:comparison:${displayComparisonValue}`}
                        className="text-xs text-muted-foreground"
                      >
                        {comparisonLabel}: {displayComparisonValue}
                      </PerformancePanelText>
                    ) : null}
                    <PerformanceDynamicValue
                      loading={loading}
                      skeletonClassName="h-5 w-24"
                      transitionKey={activeStatusLabel}
                    >
                      <div className="flex items-center gap-2">
                        <StatusIcon
                          className={cn("size-5", statusStyle.labelClassName)}
                        />
                        <span
                          className={cn(
                            "font-medium",
                            statusStyle.labelClassName,
                          )}
                        >
                          {activeStatusLabel}
                        </span>
                      </div>
                    </PerformanceDynamicValue>
                  </div>
                  <AutoTransition
                    initial={false}
                    transitionKey={
                      loading
                        ? "loading"
                        : `${activePanel}:${scoreValue ?? "--"}`
                    }
                    duration={0.2}
                    type="fade"
                    presenceMode="wait"
                    className="size-[4.5rem] shrink-0"
                  >
                    {loading ? (
                      <Skeleton
                        key="loading"
                        className="size-[4.5rem] rounded-full"
                      />
                    ) : (
                      <div
                        key="ready"
                        className="relative flex size-[4.5rem] items-center justify-center rounded-full"
                        style={{
                          background: `conic-gradient(${ringColor} ${ringPercent * 3.6}deg, var(--muted) 0deg)`,
                        }}
                      >
                        <div className="absolute inset-[6px] rounded-full bg-card" />
                        <div className="relative z-10 flex items-baseline">
                          <span className="text-xl font-semibold tracking-tight">
                            {scoreValue ?? "--"}
                          </span>
                          {scoreValue == null ? null : (
                            <span className="ml-0.5 text-[0.65rem] font-medium text-muted-foreground">
                              %
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </AutoTransition>
                </div>
                <PerformancePanelText
                  transitionKey={description}
                  className="max-w-xl text-sm leading-6 text-muted-foreground"
                >
                  {description}
                </PerformancePanelText>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {messages.performance.interpretationTitle}
                </div>
                <AutoResizer className="max-w-xl" duration={0.2}>
                  <AutoTransition
                    initial={false}
                    transitionKey={loading ? "loading" : reading}
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    className="space-y-2"
                  >
                    {loading ? (
                      <div key="loading" className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-7/12" />
                      </div>
                    ) : (
                      <p
                        key="ready"
                        className="text-sm leading-6 text-muted-foreground"
                      >
                        {reading}
                      </p>
                    )}
                  </AutoTransition>
                </AutoResizer>
              </div>
              <div className="rounded-none bg-muted/45 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <RiSpeedUpLine className="size-4 text-muted-foreground" />
                  {messages.performance.datasetTitle}
                </div>
                <PerformancePanelText
                  transitionKey={thresholdText}
                  className="text-sm leading-6 text-muted-foreground"
                >
                  {thresholdText}
                </PerformancePanelText>
              </div>
            </div>
          </div>
        </AutoResizer>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3">
              <div className="text-xs text-muted-foreground">
                {messages.performance.pathsAnalyzedLabel}
              </div>
              <PerformanceSpinnerValue
                loading={loading}
                transitionKey={`${pathCount}:${comparisonPathCount ?? "--"}`}
              >
                <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                  <span>{numberFormat(locale, pathCount)}</span>
                  {comparisonLabel ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {comparisonLabel}:{" "}
                      {numberFormat(locale, comparisonPathCount ?? 0)}
                    </span>
                  ) : null}
                </div>
              </PerformanceSpinnerValue>
            </div>
            <div className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3">
              <div className="text-xs text-muted-foreground">
                {messages.performance.samplesLabel}
              </div>
              <PerformanceSpinnerValue
                loading={loading}
                transitionKey={`${activeSummary.samples}:${comparisonSummary?.samples ?? "--"}`}
              >
                <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                  <span>{numberFormat(locale, activeSummary.samples)}</span>
                  {comparisonLabel ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {comparisonLabel}:{" "}
                      {numberFormat(locale, comparisonSummary?.samples ?? 0)}
                    </span>
                  ) : null}
                </div>
              </PerformanceSpinnerValue>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["p50", messages.performance.p50Label, activeSummary.p50],
              ["p75", messages.performance.p75Label, activeSummary.p75],
              ["p95", messages.performance.p95Label, activeSummary.p95],
            ].map(([key, label, value]) => (
              <div
                key={key as string}
                className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3"
              >
                <div className="text-xs text-muted-foreground">
                  {label as string}
                </div>
                <PerformanceSpinnerValue
                  loading={loading}
                  transitionKey={`${formatPanelValue(
                    locale,
                    messages,
                    activePanel,
                    value as number | null,
                  )}:${formatPanelValue(
                    locale,
                    messages,
                    activePanel,
                    comparisonSummary?.[key as "p50" | "p75" | "p95"] ?? null,
                  )}`}
                >
                  <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                    <span>
                      {formatPanelValue(
                        locale,
                        messages,
                        activePanel,
                        value as number | null,
                      )}
                    </span>
                    {comparisonLabel ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {comparisonLabel}:{" "}
                        {formatPanelValue(
                          locale,
                          messages,
                          activePanel,
                          comparisonSummary?.[key as "p50" | "p75" | "p95"] ??
                            null,
                        )}
                      </span>
                    ) : null}
                  </div>
                </PerformanceSpinnerValue>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

function CountryLabelWithFlag({
  label,
  iconName,
}: {
  label: string;
  iconName: string | null;
}) {
  if (!iconName) {
    return <span className="truncate">{label}</span>;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon
        icon={iconName}
        style={{ width: 16, height: 12 }}
        className="block shrink-0"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

const PerformanceHealthMapVisual = memo(function PerformanceHealthMapVisual({
  locale,
  messages,
  activePanel,
  featureCollection,
  mapFeatures,
  countryMap,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  featureCollection: CountriesFeatureCollection | null;
  mapFeatures: PerformanceMapFeature[];
  countryMap: Map<string, CountryHealthRow>;
  loading?: boolean;
}) {
  const [hoveredCountry, setHoveredCountry] = useState<CountryMapHover | null>(
    null,
  );

  useEffect(() => {
    setHoveredCountry(null);
  }, [activePanel]);

  const updateCountryHover = (
    hoverKey: string,
    feature: CountryFeature,
    code: string | null,
    country: CountryHealthRow | null,
    status: PerformanceStatus,
  ) => {
    const label =
      country?.label ??
      resolveCountryLabelFromFeature(
        feature,
        code,
        locale,
        messages.common.unknown,
      );
    const samples = country?.samples ?? 0;
    const score = country?.score ?? null;
    setHoveredCountry((current) => {
      if (
        current?.key === hoverKey &&
        current.label === label &&
        current.samples === samples &&
        current.score === score &&
        current.status === status
      ) {
        return current;
      }

      return {
        key: hoverKey,
        label,
        samples,
        score,
        status,
      };
    });
  };
  const hoverScore = roundedScore(hoveredCountry?.score);
  const hoveredSamplesText = numberFormat(locale, hoveredCountry?.samples ?? 0);
  const hoveredScoreText =
    hoverScore == null ? "-" : numberFormat(locale, hoverScore);
  const mapTransitionKey = loading
    ? "loading"
    : featureCollection
      ? activePanel
      : "resource-loading";

  return (
    <div className="relative overflow-hidden border-t border-border/70 bg-muted/20 p-3">
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          initial={false}
          transitionKey={mapTransitionKey}
          duration={0.22}
          type="fade"
          presenceMode="wait"
          className="w-full"
        >
          {featureCollection && !loading ? (
            <div
              key={`map-${activePanel}`}
              className="relative mx-auto aspect-[960/500] w-full"
              onMouseLeave={() => setHoveredCountry(null)}
            >
              <svg
                role="img"
                aria-label={messages.performance.countryHealthTitle}
                className="block h-full w-full"
                viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <rect
                  width={WORLD_MAP_WIDTH}
                  height={WORLD_MAP_HEIGHT}
                  fill="transparent"
                />
                {mapFeatures.map(({ code, feature, hoverKey, path }) => {
                  const country = code ? countryMap.get(code) : null;
                  const status = country?.status ?? "none";
                  const isHovered = hoveredCountry?.key === hoverKey;
                  return (
                    <path
                      key={hoverKey}
                      d={path}
                      fill={statusColor(status)}
                      fillRule="evenodd"
                      fillOpacity={
                        isHovered
                          ? Math.min(
                              0.82,
                              countryFillOpacity(
                                status,
                                country?.samples ?? 0,
                              ) + 0.22,
                            )
                          : countryFillOpacity(status, country?.samples ?? 0)
                      }
                      stroke={isHovered ? "var(--foreground)" : "var(--border)"}
                      strokeOpacity={isHovered ? 0.96 : 0.86}
                      strokeWidth={isHovered ? 1 : 0.65}
                      vectorEffect="non-scaling-stroke"
                      className="cursor-default transition-[fill-opacity,stroke,stroke-opacity] duration-150"
                      onMouseEnter={() =>
                        updateCountryHover(
                          hoverKey,
                          feature,
                          code,
                          country ?? null,
                          status,
                        )
                      }
                      onMouseMove={() =>
                        updateCountryHover(
                          hoverKey,
                          feature,
                          code,
                          country ?? null,
                          status,
                        )
                      }
                    />
                  );
                })}
              </svg>
              <AnimatePresence>
                {hoveredCountry ? (
                  <motion.div
                    key="performance-country-toolbar"
                    className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 12 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                  >
                    <div className="inline-flex max-w-full items-center gap-4 rounded-md border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
                      <AutoResizer
                        initial
                        animateWidth
                        animateHeight={false}
                        className="inline-flex min-w-0 shrink items-center"
                      >
                        <AutoTransition
                          className="inline-block"
                          duration={0.2}
                          type="fade"
                          initial={false}
                          presenceMode="wait"
                          customVariants={{
                            initial: { opacity: 0 },
                            animate: { opacity: 1 },
                            exit: { opacity: 0 },
                          }}
                        >
                          <span
                            key={`country-${hoveredCountry.key}-${hoveredCountry.label}`}
                            className="inline-flex items-center gap-2 whitespace-nowrap font-medium"
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{
                                backgroundColor: statusColor(
                                  hoveredCountry.status,
                                ),
                              }}
                            />
                            {hoveredCountry.label}
                          </span>
                        </AutoTransition>
                      </AutoResizer>
                      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                        <span>{messages.performance.samplesLabel}:</span>
                        <AutoResizer
                          initial
                          animateWidth
                          animateHeight={false}
                          className="inline-flex shrink-0 items-center"
                        >
                          <AutoTransition
                            className="inline-block whitespace-nowrap font-mono text-foreground tabular-nums"
                            duration={0.2}
                            type="fade"
                            initial={false}
                            presenceMode="wait"
                            customVariants={{
                              initial: { opacity: 0 },
                              animate: { opacity: 1 },
                              exit: { opacity: 0 },
                            }}
                          >
                            <span key={`samples-${hoveredSamplesText}`}>
                              {hoveredSamplesText}
                            </span>
                          </AutoTransition>
                        </AutoResizer>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                        <span>{messages.performance.score}:</span>
                        <AutoResizer
                          initial
                          animateWidth
                          animateHeight={false}
                          className="inline-flex shrink-0 items-center"
                        >
                          <AutoTransition
                            className="inline-block whitespace-nowrap font-mono text-foreground tabular-nums"
                            duration={0.2}
                            type="fade"
                            initial={false}
                            presenceMode="wait"
                            customVariants={{
                              initial: { opacity: 0 },
                              animate: { opacity: 1 },
                              exit: { opacity: 0 },
                            }}
                          >
                            <span key={`score-${hoveredScoreText}`}>
                              {hoveredScoreText}
                            </span>
                          </AutoTransition>
                        </AutoResizer>
                      </span>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          ) : (
            <Skeleton
              key={loading ? "loading" : "resource-loading"}
              className="mx-auto aspect-[2/1] w-full rounded-none"
            />
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
});

const PerformanceHealthMapCard = memo(function PerformanceHealthMapCard({
  locale,
  messages,
  activePanel,
  countries,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  countries: CountryHealthRow[];
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const [featureCollection, setFeatureCollection] =
    useState<CountriesFeatureCollection | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/public/resources/world-countries", { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active) return;
        const next =
          payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "FeatureCollection" &&
          Array.isArray((payload as { features?: unknown }).features)
            ? (payload as CountriesFeatureCollection)
            : null;
        setFeatureCollection(next);
      })
      .catch(() => {
        if (!active) return;
        setFeatureCollection(null);
      });

    return () => {
      active = false;
    };
  }, []);

  const countryMap = useMemo(() => {
    const map = new Map<string, CountryHealthRow>();
    for (const country of countries) {
      const code = normalizeCountryCode(country.country);
      if (!code) continue;
      map.set(code, country);
    }
    return map;
  }, [countries]);
  const mapFeatures = useMemo(() => {
    if (!featureCollection) return [];

    return featureCollection.features
      .map((feature, index) => {
        const code = resolveCountryCodeFromFeature(feature);
        return {
          code,
          feature,
          hoverKey: `${code ?? "country"}-${index}`,
          path: geometryToPath(feature.geometry),
        };
      })
      .filter((entry) => entry.path.length > 0);
  }, [featureCollection]);
  const [sort, setSort] = useState<{
    key: PathSortKey;
    direction: SortDirection;
  }>({
    key: "samples",
    direction: "desc",
  });
  const sortedCountries = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...countries].sort((a, b) => {
      if (sort.key === "samples") {
        if (comparisonLabel) {
          return (
            ((a.comparisonValue ?? a.comparisonScore ?? -1) -
              (b.comparisonValue ?? b.comparisonScore ?? -1)) *
            direction
          );
        }
        return (a.samples - b.samples) * direction;
      }
      if (sort.key === "score") {
        return ((a.score ?? -1) - (b.score ?? -1)) * direction;
      }
      return ((a.value ?? -1) - (b.value ?? -1)) * direction;
    });
  }, [comparisonLabel, countries, sort.direction, sort.key]);
  const groupedRows = useMemo(
    () => ({
      poor: sortedCountries.filter((row) => row.status === "poor"),
      "needs-improvement": sortedCountries.filter(
        (row) => row.status === "needs-improvement",
      ),
      great: sortedCountries.filter((row) => row.status === "great"),
    }),
    [sortedCountries],
  );
  const countryHealthSubtitle = formatI18nTemplate(
    messages.performance.countryHealthSubtitle,
    { metric: panelLabel(messages, activePanel) },
  );

  const updateSort = useCallback((key: PathSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="inline-flex items-center gap-2">
              <RiMapPin2Line className="size-4" />
              {messages.performance.countryHealthTitle}
            </CardTitle>
            <PerformancePanelText
              transitionKey={countryHealthSubtitle}
              className="text-sm text-muted-foreground"
            >
              {countryHealthSubtitle}
            </PerformancePanelText>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <PerformanceHealthMapVisual
          locale={locale}
          messages={messages}
          activePanel={activePanel}
          featureCollection={featureCollection}
          mapFeatures={mapFeatures}
          countryMap={countryMap}
          loading={loading}
        />
        <div className="grid min-h-[18rem] divide-y divide-border/70 border-t border-border/70 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {(["poor", "needs-improvement", "great"] as const).map((status) => (
            <CountryStatusColumn
              key={status}
              locale={locale}
              messages={messages}
              activePanel={activePanel}
              status={status}
              rows={groupedRows[status]}
              sort={sort}
              onSort={updateSort}
              comparisonLabel={comparisonLabel}
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

const CountryStatusColumn = memo(function CountryStatusColumn({
  locale,
  messages,
  activePanel,
  status,
  rows,
  sort,
  onSort,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  status: Exclude<PerformanceStatus, "none">;
  rows: CountryHealthRow[];
  sort: { key: PathSortKey; direction: SortDirection };
  onSort: (key: PathSortKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const statusStyle = STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;
  const displayRows = loading ? COUNTRY_TABLE_SKELETON_ROWS : rows;
  const rangeLabel = pathStatusRangeLabel(
    locale,
    messages,
    activePanel,
    status,
  );
  const columns = useMemo<
    readonly TabbedDataTableColumn<
      CountryHealthRow,
      PathSortKey,
      typeof status
    >[]
  >(() => {
    const metricLabel =
      activePanel === "score"
        ? messages.performance.score
        : messages.performance.metricValueColumn;

    if (comparisonLabel) {
      return [
        {
          key: "samples",
          label: comparisonLabel,
          getValue: (row) => row.comparisonValue ?? row.comparisonScore ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span className="text-muted-foreground">
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.comparisonValue ?? row.comparisonScore,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
        {
          key: "value",
          label: metricLabel,
          getValue: (row) => row.value ?? row.score ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span>
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.value ?? row.score,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
      ];
    }

    return [
      {
        key: "samples",
        label: messages.performance.samplesLabel,
        getValue: (row) => row.samples,
        format: (value) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-12" />
          ) : (
            <span>{numberFormat(locale, value)}</span>
          ),
        className: "font-mono tabular-nums",
      },
      {
        key: "value",
        label: metricLabel,
        getValue: (row) => row.value ?? row.score ?? 0,
        format: (_value, row) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-14" />
          ) : (
            <span>
              {formatPanelValue(
                locale,
                messages,
                activePanel,
                row.value ?? row.score,
              )}
            </span>
          ),
        className: "font-mono tabular-nums",
      },
    ];
  }, [
    activePanel,
    comparisonLabel,
    loading,
    locale,
    messages,
    messages.performance.metricValueColumn,
    messages.performance.samplesLabel,
    messages.performance.score,
  ]);
  const tabs = useMemo(
    () =>
      [
        {
          value: status,
          label: statusLabel(messages, status),
          columnLabel: messages.common.country,
          defaultSort: sort,
        },
      ] as const,
    [messages, sort, status],
  );
  const sortByTab = useMemo(
    () => ({ [status]: sort }) as Record<typeof status, typeof sort>,
    [sort, status],
  );
  const handleSortChange = useCallback(
    (_tab: typeof status, next: TabbedDataTableSortState<PathSortKey>) =>
      onSort(next.key),
    [onSort],
  );
  const loader = useCallback<
    TabbedDataTableLoader<typeof status, CountryHealthRow, PathSortKey>
  >(
    async ({ cursor, limit, search, sort }) =>
      loadLocalTablePage({
        rows: displayRows,
        sort,
        columns,
        tab: status,
        limit,
        cursor,
        search,
        getText: (row) => row.label,
        tieBreakText: false,
      }),
    [columns, displayRows, status],
  );
  const tableRequestKey = useMemo(
    () => `${activePanel}:${locale}:${JSON.stringify(displayRows)}`,
    [activePanel, displayRows, locale],
  );
  const rowAdapter = useMemo<
    TabbedDataTableRowAdapter<CountryHealthRow, typeof status, PathSortKey>
  >(
    () => ({
      renderLabel: (row) =>
        loading ? (
          <Skeleton className="h-4 w-[min(12rem,78%)]" />
        ) : (
          <span className="max-w-[18rem]">
            <CountryLabelWithFlag label={row.label} iconName={row.iconName} />
          </span>
        ),
      getSearchText: (row) => row.label,
      getExportLabel: (row) => row.label,
      getClassName: () => "hover:brightness-[0.98] dark:hover:brightness-125",
    }),
    [loading],
  );

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0 space-y-1">
          <div
            className={cn(
              "flex items-center gap-2 font-medium",
              statusStyle.labelClassName,
            )}
          >
            <StatusIcon className="size-4" />
            {statusLabel(messages, status)}
          </div>
          <PerformancePanelText
            transitionKey={rangeLabel}
            className="text-xs text-muted-foreground"
          >
            {rangeLabel}
          </PerformancePanelText>
        </div>
        <PerformanceDynamicValue
          loading={loading}
          skeletonClassName="h-4 w-8"
          className="shrink-0"
          transitionKey={rows.length}
        >
          <div className="font-mono text-sm text-muted-foreground tabular-nums">
            {numberFormat(locale, rows.length)}
          </div>
        </PerformanceDynamicValue>
      </div>
      <div className="pb-4">
        <TabbedDataTableCard<typeof status, CountryHealthRow, PathSortKey>
          tabs={tabs}
          loader={loader}
          columns={columns}
          value={status}
          sortByTab={sortByTab}
          onSortChange={handleSortChange}
          rowAdapter={rowAdapter}
          requestKey={tableRequestKey}
          sortActionLabel={(label) =>
            formatI18nTemplate(messages.common.sortBy, { label })
          }
          loadingLabel={messages.common.loading}
          emptyLabel={messages.common.noData}
          headerHidden
          search={false}
          progress={comparisonLabel ? "value" : "samples"}
        />
      </div>
    </div>
  );
});

function pathStatusRangeLabel(
  locale: Locale,
  messages: AppMessages,
  activePanel: PerformancePanelKey,
  status: Exclude<PerformanceStatus, "none">,
): string {
  if (activePanel === "score") {
    if (status === "poor") return "<50";
    if (status === "needs-improvement") return "50 - 90";
    return ">90";
  }

  const thresholds = METRIC_THRESHOLDS[activePanel];
  if (status === "poor") {
    return `>${formatMetricValue(locale, messages, activePanel, thresholds.poor)}`;
  }
  if (status === "needs-improvement") {
    return `${formatMetricValue(
      locale,
      messages,
      activePanel,
      thresholds.good,
    )} - ${formatMetricValue(locale, messages, activePanel, thresholds.poor)}`;
  }
  return `<=${formatMetricValue(locale, messages, activePanel, thresholds.good)}`;
}

const PathStatusColumn = memo(function PathStatusColumn({
  locale,
  messages,
  activePanel,
  status,
  rows,
  sort,
  onSort,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  status: Exclude<PerformanceStatus, "none">;
  rows: PathPerformanceRow[];
  sort: { key: PathSortKey; direction: SortDirection };
  onSort: (key: PathSortKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const statusStyle = STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;
  const displayRows = loading ? PATH_TABLE_SKELETON_ROWS : rows;
  const rangeLabel = pathStatusRangeLabel(
    locale,
    messages,
    activePanel,
    status,
  );
  const columns = useMemo<
    readonly TabbedDataTableColumn<
      PathPerformanceRow,
      PathSortKey,
      typeof status
    >[]
  >(() => {
    const metricLabel =
      activePanel === "score"
        ? messages.performance.score
        : messages.performance.metricValueColumn;

    if (comparisonLabel) {
      return [
        {
          key: "samples",
          label: comparisonLabel,
          getValue: (row) => row.comparisonValue ?? row.comparisonScore ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span className="text-muted-foreground">
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.comparisonValue ?? row.comparisonScore,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
        {
          key: "value",
          label: metricLabel,
          getValue: (row) => row.value ?? row.score ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span>
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.value ?? row.score,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
      ];
    }

    return [
      {
        key: "samples",
        label: messages.performance.samplesLabel,
        getValue: (row) => row.samples,
        format: (value) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-12" />
          ) : (
            <span>{numberFormat(locale, value)}</span>
          ),
        className: "font-mono tabular-nums",
      },
      {
        key: "value",
        label: metricLabel,
        getValue: (row) => row.value ?? row.score ?? 0,
        format: (_value, row) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-14" />
          ) : (
            <span>
              {formatPanelValue(
                locale,
                messages,
                activePanel,
                row.value ?? row.score,
              )}
            </span>
          ),
        className: "font-mono tabular-nums",
      },
    ];
  }, [
    activePanel,
    comparisonLabel,
    loading,
    locale,
    messages,
    messages.performance.metricValueColumn,
    messages.performance.samplesLabel,
    messages.performance.score,
  ]);
  const tabs = useMemo(
    () =>
      [
        {
          value: status,
          label: statusLabel(messages, status),
          columnLabel: messages.common.path,
          defaultSort: sort,
        },
      ] as const,
    [messages, sort, status],
  );
  const sortByTab = useMemo(
    () => ({ [status]: sort }) as Record<typeof status, typeof sort>,
    [sort, status],
  );
  const handleSortChange = useCallback(
    (_tab: typeof status, next: TabbedDataTableSortState<PathSortKey>) =>
      onSort(next.key),
    [onSort],
  );
  const loader = useCallback<
    TabbedDataTableLoader<typeof status, PathPerformanceRow, PathSortKey>
  >(
    async ({ cursor, limit, search, sort }) =>
      loadLocalTablePage({
        rows: displayRows,
        sort,
        columns,
        tab: status,
        limit,
        cursor,
        search,
        getText: (row) => row.pathname || "/",
        tieBreakText: false,
      }),
    [columns, displayRows, status],
  );
  const tableRequestKey = useMemo(
    () => `${activePanel}:${locale}:${JSON.stringify(displayRows)}`,
    [activePanel, displayRows, locale],
  );
  const rowAdapter = useMemo<
    TabbedDataTableRowAdapter<PathPerformanceRow, typeof status, PathSortKey>
  >(
    () => ({
      renderLabel: (row) =>
        loading ? (
          <Skeleton className="h-4 w-[min(14rem,82%)]" />
        ) : (
          <span className="max-w-[18rem] font-mono break-words">
            {decodeUrlDisplayValue(row.pathname || "/")}
          </span>
        ),
      getSearchText: (row) => row.pathname || "/",
      getExportLabel: (row) => row.pathname || "/",
      getClassName: () => "hover:brightness-[0.98] dark:hover:brightness-125",
    }),
    [loading],
  );

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0 space-y-1">
          <div
            className={cn(
              "flex items-center gap-2 font-medium",
              statusStyle.labelClassName,
            )}
          >
            <StatusIcon className="size-4" />
            {statusLabel(messages, status)}
          </div>
          <PerformancePanelText
            transitionKey={rangeLabel}
            className="text-xs text-muted-foreground"
          >
            {rangeLabel}
          </PerformancePanelText>
        </div>
        <PerformancePanelText
          transitionKey={rows.length}
          className="font-mono text-sm text-muted-foreground tabular-nums"
        >
          {numberFormat(locale, rows.length)}
        </PerformancePanelText>
      </div>
      <div className="pb-4">
        <TabbedDataTableCard<typeof status, PathPerformanceRow, PathSortKey>
          tabs={tabs}
          loader={loader}
          columns={columns}
          value={status}
          sortByTab={sortByTab}
          onSortChange={handleSortChange}
          rowAdapter={rowAdapter}
          requestKey={tableRequestKey}
          sortActionLabel={(label) =>
            formatI18nTemplate(messages.common.sortBy, { label })
          }
          loadingLabel={messages.common.loading}
          emptyLabel={messages.common.noData}
          headerHidden
          search={false}
          progress={comparisonLabel ? "value" : "samples"}
        />
      </div>
    </div>
  );
});

const PathPerformanceTable = memo(function PathPerformanceTable({
  locale,
  messages,
  activePanel,
  rows,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  rows: PathPerformanceRow[];
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const [sort, setSort] = useState<{
    key: PathSortKey;
    direction: SortDirection;
  }>({
    key: "samples",
    direction: "desc",
  });
  const sortedRows = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "samples") {
        if (comparisonLabel) {
          return (
            ((a.comparisonValue ?? a.comparisonScore ?? -1) -
              (b.comparisonValue ?? b.comparisonScore ?? -1)) *
            direction
          );
        }
        return (a.samples - b.samples) * direction;
      }
      if (sort.key === "score") {
        return ((a.score ?? -1) - (b.score ?? -1)) * direction;
      }
      return ((a.value ?? -1) - (b.value ?? -1)) * direction;
    });
  }, [comparisonLabel, rows, sort.direction, sort.key]);
  const groupedRows = useMemo(
    () => ({
      poor: sortedRows.filter((row) => row.status === "poor"),
      "needs-improvement": sortedRows.filter(
        (row) => row.status === "needs-improvement",
      ),
      great: sortedRows.filter((row) => row.status === "great"),
    }),
    [sortedRows],
  );

  const updateSort = useCallback((key: PathSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="inline-flex items-center gap-2">
              <RiRouteLine className="size-4" />
              {messages.performance.pathsTitle}
            </CardTitle>
            <PerformancePanelText
              transitionKey={activePanel}
              className="text-sm text-muted-foreground"
            >
              {panelLabel(messages, activePanel)}
            </PerformancePanelText>
          </div>
          <div className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            {messages.performance.pathsAnalyzedLabel}:{" "}
            <PerformanceDynamicValue
              loading={loading}
              skeletonClassName="h-4 w-8"
              className="shrink-0"
            >
              <span className="font-mono tabular-nums">
                {numberFormat(locale, rows.length)}
              </span>
            </PerformanceDynamicValue>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid min-h-[18rem] divide-y divide-border/70 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {(["poor", "needs-improvement", "great"] as const).map((status) => (
            <PathStatusColumn
              key={status}
              locale={locale}
              messages={messages}
              activePanel={activePanel}
              status={status}
              rows={groupedRows[status]}
              sort={sort}
              onSort={updateSort}
              comparisonLabel={comparisonLabel}
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

export function PerformanceClientPage({
  locale,
  messages,
  siteId,
}: PerformanceClientPageProps) {
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const [activePanel, setActivePanel] = useState<PerformancePanelKey>("score");
  const comparisonQuery = useDashboardComparisonQuery(timeWindow, filters);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : null),
    [comparisonQuery],
  );
  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [
      "dashboard",
      "performance",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      comparisonQuery?.mode ?? null,
      comparisonQuery?.window.from ?? null,
      comparisonQuery?.window.to ?? null,
      comparisonQuery?.window.interval ?? null,
      comparisonQuery?.window.timeZone ?? null,
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const currentPromise = fetchPerformance(siteId, timeWindow, filters, {
        signal,
      });
      const comparisonPromise = comparisonQuery
        ? fetchPerformance(
            siteId,
            comparisonQuery.window,
            comparisonQuery.filters,
            { signal },
          )
        : Promise.resolve(null);
      const [performanceData, comparisonData] = await Promise.all([
        currentPromise,
        comparisonPromise,
      ]);

      return {
        performanceData,
        comparisonData,
        dataWindow: {
          from: timeWindow.from,
          to: timeWindow.to,
          interval: timeWindow.interval,
          timeZone: timeWindow.timeZone,
        },
        comparisonDataWindow: comparisonQuery
          ? {
              from: comparisonQuery.window.from,
              to: comparisonQuery.window.to,
              interval: comparisonQuery.window.interval,
              timeZone: comparisonQuery.window.timeZone,
            }
          : null,
      };
    },
    placeholderData: keepPreviousData,
    enabled: typeof window !== "undefined",
  });
  const loading = isPending || isPlaceholderData;
  const performanceData =
    data?.performanceData ?? emptyPerformance(timeWindow.interval);
  const comparisonPerformanceData = data?.comparisonData ?? null;
  const dataWindow = data?.dataWindow ?? {
    from: timeWindow.from,
    to: timeWindow.to,
    interval: timeWindow.interval,
    timeZone: timeWindow.timeZone,
  };
  const comparisonDataWindow = data?.comparisonDataWindow ?? null;
  const comparisonLabel = comparisonQuery
    ? dashboardComparisonLabel(messages, comparisonQuery)
    : null;

  const summaryByPanel = useMemo(
    () =>
      new Map<PerformancePanelKey, PerformanceSummary>(
        PERFORMANCE_PANELS.map((key) => [
          key,
          key === "score"
            ? scoreSummary(performanceData)
            : (performanceData.summaries[key] ?? EMPTY_SUMMARY),
        ]),
      ),
    [performanceData],
  );
  const activeSummary = summaryByPanel.get(activePanel) ?? EMPTY_SUMMARY;
  const activeValue = activeSummary.p75 ?? activeSummary.avg;
  const comparisonSummaryByPanel = useMemo(() => {
    if (!comparisonPerformanceData) return null;
    return new Map<PerformancePanelKey, PerformanceSummary>(
      PERFORMANCE_PANELS.map((key) => [
        key,
        key === "score"
          ? scoreSummary(comparisonPerformanceData)
          : (comparisonPerformanceData.summaries[key] ?? EMPTY_SUMMARY),
      ]),
    );
  }, [comparisonPerformanceData]);
  const comparisonSummary = comparisonSummaryByPanel?.get(activePanel) ?? null;
  const comparisonValue = comparisonSummary
    ? (comparisonSummary.p75 ?? comparisonSummary.avg)
    : null;

  const chartPoints = useMemo(
    () =>
      activePanel === "score"
        ? buildScoreTrend(performanceData, dataWindow)
        : buildMetricTrend(performanceData, activePanel, dataWindow),
    [activePanel, dataWindow, performanceData],
  );
  const comparisonChartPoints = useMemo(() => {
    if (!comparisonPerformanceData || !comparisonDataWindow) return [];
    const points =
      activePanel === "score"
        ? buildScoreTrend(comparisonPerformanceData, comparisonDataWindow)
        : buildMetricTrend(
            comparisonPerformanceData,
            activePanel,
            comparisonDataWindow,
          );
    return alignComparisonTrend(chartPoints, points);
  }, [
    activePanel,
    chartPoints,
    comparisonDataWindow,
    comparisonPerformanceData,
  ]);
  const performanceTrendLabels = useMemo<PerformanceTrendChartLabels>(
    () => ({
      p50: messages.performance.p50Label,
      p75: messages.performance.p75Label,
      p95: messages.performance.p95Label,
    }),
    [
      messages.performance.p50Label,
      messages.performance.p75Label,
      messages.performance.p95Label,
    ],
  );
  const formatPerformanceTrendValue = useCallback(
    (value: number | null | undefined) =>
      formatPanelValue(locale, messages, activePanel, value),
    [activePanel, locale, messages],
  );

  const metricCards = useMemo<MetricCardModel[]>(() => {
    return PERFORMANCE_PANELS.map((key) => {
      const summary = summaryByPanel.get(key) ?? EMPTY_SUMMARY;
      const value = summary.p75 ?? summary.avg;
      const score = key === "score" ? value : metricScore(key, value);
      const status =
        key === "score" ? scoreStatus(value) : metricStatus(key, value);
      return {
        key,
        label: panelLabel(messages, key),
        valueLabel: formatPanelValue(locale, messages, key, value),
        value,
        summary,
        status,
        score,
        comparisonValue:
          comparisonSummaryByPanel?.get(key)?.p75 ??
          comparisonSummaryByPanel?.get(key)?.avg ??
          null,
        changeRate: performanceChangeRate(
          value,
          comparisonSummaryByPanel?.get(key)?.p75 ??
            comparisonSummaryByPanel?.get(key)?.avg,
        ),
      };
    });
  }, [comparisonSummaryByPanel, locale, messages, summaryByPanel]);

  const comparisonRouteMap = useMemo(() => {
    const map = new Map<string, PerformanceRouteSummary>();
    for (const route of comparisonPerformanceData?.routes ?? []) {
      map.set(route.pathname || "/", route);
    }
    return map;
  }, [comparisonPerformanceData?.routes]);

  const pathRows = useMemo<PathPerformanceRow[]>(
    () =>
      (performanceData.routes ?? []).map((route) => {
        const value = routeValue(route, activePanel);
        const score = routeScore(route);
        const pathname = route.pathname || "/";
        const comparisonRoute = comparisonRouteMap.get(pathname);
        return {
          key: pathname,
          pathname,
          views: route.views ?? 0,
          samples: routeSamples(route, activePanel),
          value,
          score,
          status: routeStatus(route, activePanel),
          comparisonViews: comparisonRoute?.views ?? 0,
          comparisonSamples: comparisonRoute
            ? routeSamples(comparisonRoute, activePanel)
            : 0,
          comparisonValue: comparisonRoute
            ? routeValue(comparisonRoute, activePanel)
            : null,
          comparisonScore: comparisonRoute ? routeScore(comparisonRoute) : null,
          comparisonStatus: comparisonRoute
            ? routeStatus(comparisonRoute, activePanel)
            : "none",
        };
      }),
    [activePanel, comparisonRouteMap, performanceData.routes],
  );

  const comparisonCountryMap = useMemo(() => {
    const map = new Map<string, PerformanceCountrySummary>();
    for (const country of comparisonPerformanceData?.countries ?? []) {
      const key = String(country.country ?? "")
        .trim()
        .toUpperCase();
      if (key) map.set(key, country);
    }
    return map;
  }, [comparisonPerformanceData?.countries]);

  const countryRows = useMemo<CountryHealthRow[]>(
    () =>
      (performanceData.countries ?? [])
        .map((country) => {
          const value = countryValue(country, activePanel);
          const score =
            activePanel === "score" ? value : metricScore(activePanel, value);
          const normalizedCountry = String(country.country ?? "")
            .trim()
            .toUpperCase();
          const comparisonCountry = comparisonCountryMap.get(normalizedCountry);
          const { label, code } = resolveCountryLabel(
            normalizedCountry,
            locale,
            messages.common.unknown,
          );
          const flagCode = resolveCountryFlagCode(code, locale);
          return {
            key: normalizedCountry,
            country: normalizedCountry,
            label,
            iconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
            views: country.views ?? 0,
            samples: countrySamples(country, activePanel),
            value,
            score,
            status: countryStatus(country, activePanel),
            comparisonViews: comparisonCountry?.views ?? 0,
            comparisonSamples: comparisonCountry
              ? countrySamples(comparisonCountry, activePanel)
              : 0,
            comparisonValue: comparisonCountry
              ? countryValue(comparisonCountry, activePanel)
              : null,
            comparisonScore: comparisonCountry
              ? countryScore(comparisonCountry)
              : null,
            comparisonStatus: comparisonCountry
              ? countryStatus(comparisonCountry, activePanel)
              : "none",
          };
        })
        .filter((country) => country.country.length > 0),
    [
      activePanel,
      comparisonCountryMap,
      locale,
      messages.common.unknown,
      performanceData.countries,
    ],
  );

  const hasContent =
    chartPoints.some((row) => row.samples > 0) ||
    metricCards.some((card) => card.valueLabel !== "--") ||
    pathRows.length > 0 ||
    countryRows.length > 0;
  const showContent = loading || hasContent;

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.performance.title}
        subtitle={messages.performance.subtitle}
      />

      {showContent ? (
        <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <PerformanceRail
            activePanel={activePanel}
            cards={metricCards}
            onSelect={setActivePanel}
            comparisonLabel={comparisonLabel ?? undefined}
            loading={loading}
          />
          <div className="min-w-0">
            <div className="space-y-4">
              <MetricSummaryCard
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                activeSummary={activeSummary}
                activeValue={activeValue}
                comparisonLabel={comparisonLabel ?? undefined}
                comparisonSummary={comparisonSummary}
                comparisonValue={comparisonValue}
                pathCount={pathRows.length}
                comparisonPathCount={
                  comparisonPerformanceData?.routes?.length ?? 0
                }
                loading={loading}
              />
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle className="inline-flex items-center gap-2">
                        <RiSpeedUpLine className="size-4" />
                        {messages.performance.chartTitle}
                      </CardTitle>
                      <PerformancePanelText
                        transitionKey={activePanel}
                        className="text-sm text-muted-foreground"
                      >
                        {panelLabel(messages, activePanel)}
                      </PerformancePanelText>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <AutoResizer className="w-full" duration={0.24}>
                    <AutoTransition
                      initial={false}
                      transitionKey={loading ? "loading" : activePanel}
                      duration={0.22}
                      type="fade"
                      presenceMode="wait"
                      className="w-full"
                    >
                      {loading ? (
                        <div key="loading" className="w-full">
                          <PerformanceTrendLoadingState messages={messages} />
                        </div>
                      ) : (
                        <div key={`chart-${activePanel}`} className="w-full">
                          <PerformanceTrendChart
                            locale={locale}
                            activePanel={activePanel}
                            dataWindow={dataWindow}
                            points={chartPoints}
                            comparisonPoints={comparisonChartPoints}
                            comparisonLabel={comparisonLabel ?? undefined}
                            labels={performanceTrendLabels}
                            metricThresholds={METRIC_THRESHOLDS}
                            formatValue={formatPerformanceTrendValue}
                          />
                        </div>
                      )}
                    </AutoTransition>
                  </AutoResizer>
                </CardContent>
              </Card>
              <PerformanceHealthMapCard
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                countries={countryRows}
                comparisonLabel={comparisonLabel ?? undefined}
                loading={loading}
              />
              <PathPerformanceTable
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                rows={pathRows}
                comparisonLabel={comparisonLabel ?? undefined}
                loading={loading}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[520px] items-center justify-center text-sm text-muted-foreground">
          {messages.common.noData}
        </div>
      )}
    </div>
  );
}
