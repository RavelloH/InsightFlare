import { memo, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Customized,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { intlLocale } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { PerformanceMetricKey } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface PerformanceTrendChartPoint {
  timestampMs: number;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  avg: number | null;
  samples: number;
}

export interface PerformanceTrendChartLabels {
  p50: string;
  p75: string;
  p95: string;
}

export type PerformanceTrendMetricThresholds = Readonly<
  Record<PerformanceMetricKey, { good: number; poor: number }>
>;

export interface PerformanceTrendChartProps {
  locale: Locale;
  activePanel: PerformanceMetricKey | "score";
  dataWindow: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">;
  points: ReadonlyArray<PerformanceTrendChartPoint>;
  labels: PerformanceTrendChartLabels;
  metricThresholds: PerformanceTrendMetricThresholds;
  formatValue: (value: number | null | undefined) => string;
  className?: string;
}

const PERFORMANCE_SERIES_COLORS = {
  p50: "var(--color-chart-1)",
  p75: "var(--color-chart-4)",
  p95: "var(--color-chart-5)",
} as const;
const PERFORMANCE_TREND_ANIMATION_DURATION_MS = 1200;
const PERFORMANCE_TREND_CONNECTOR_DELAY_MS =
  PERFORMANCE_TREND_ANIMATION_DURATION_MS + 120;
const PERFORMANCE_TREND_LEGEND_CLASS =
  "pt-6 flex-wrap justify-center gap-x-4 gap-y-2 [&>div>div]:h-2.5 [&>div>div]:w-2.5 [&>div>div]:shrink-0 [&>div>div]:rounded-none";

const ZONE_COLORS = {
  great: "var(--color-chart-2)",
  needsImprovement: "oklch(0.75 0.16 80)",
  poor: "var(--color-destructive)",
} as const;

function tickDateFormat(
  localeCode: string,
  interval: TimeWindow["interval"],
  timeZone: string,
) {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "short",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    month: "short",
    day: "numeric",
  });
}

function tooltipDateFormat(
  localeCode: string,
  interval: TimeWindow["interval"],
  timeZone: string,
) {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "long",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function chartDomain(
  key: PerformanceMetricKey | "score",
  points: ReadonlyArray<PerformanceTrendChartPoint>,
  metricThresholds: PerformanceTrendMetricThresholds,
): [number, number] {
  if (key === "score") return [0, 100];
  const thresholds = metricThresholds[key];
  const observedMax = points.reduce((max, point) => {
    const values = [point.p50, point.p75, point.p95].filter(
      (value): value is number => value != null && Number.isFinite(value),
    );
    return Math.max(max, ...values);
  }, thresholds.poor);

  if (key === "cls") {
    return [0, Math.max(0.3, Math.ceil(observedMax * 120) / 100)];
  }
  return [
    0,
    Math.max(thresholds.poor * 1.2, Math.ceil((observedMax * 1.2) / 100) * 100),
  ];
}

function zoneBackground(
  key: PerformanceMetricKey | "score",
  domainMax: number,
  metricThresholds: PerformanceTrendMetricThresholds,
): string {
  const great = "color-mix(in oklch, var(--color-chart-4) 26%, transparent)";
  const needs = "color-mix(in oklch, oklch(0.75 0.16 80) 24%, transparent)";
  const poor = "color-mix(in oklch, var(--color-destructive) 24%, transparent)";

  if (key === "score") {
    return `linear-gradient(to bottom, ${great} 0% 10%, ${needs} 10% 50%, ${poor} 50% 100%)`;
  }

  const thresholds = metricThresholds[key];
  const safeDomainMax = Math.max(domainMax, thresholds.poor);
  const poorEnd = Math.max(
    0,
    Math.min(100, 100 - (thresholds.poor / safeDomainMax) * 100),
  );
  const needsEnd = Math.max(
    poorEnd,
    Math.min(100, 100 - (thresholds.good / safeDomainMax) * 100),
  );
  return `linear-gradient(to bottom, ${poor} 0% ${poorEnd}%, ${needs} ${poorEnd}% ${needsEnd}%, ${great} ${needsEnd}% 100%)`;
}

function TrendZones({
  activePanel,
  metricThresholds,
}: {
  activePanel: PerformanceMetricKey | "score";
  metricThresholds: PerformanceTrendMetricThresholds;
}) {
  if (activePanel === "score") {
    return (
      <>
        <ReferenceLine
          y={50}
          stroke={ZONE_COLORS.needsImprovement}
          strokeDasharray="7 5"
          strokeWidth={2}
        />
        <ReferenceLine
          y={90}
          stroke={ZONE_COLORS.great}
          strokeDasharray="7 5"
          strokeWidth={2}
        />
      </>
    );
  }

  const { good, poor } = metricThresholds[activePanel];
  return (
    <>
      <ReferenceLine
        y={good}
        stroke={ZONE_COLORS.great}
        strokeDasharray="7 5"
        strokeWidth={2}
      />
      <ReferenceLine
        y={poor}
        stroke={ZONE_COLORS.needsImprovement}
        strokeDasharray="7 5"
        strokeWidth={2}
      />
    </>
  );
}

function hasTrendValue(
  point: PerformanceTrendChartPoint | undefined,
  seriesKey: PerformanceSeriesKey,
): boolean {
  const value = point?.[seriesKey];
  return value != null && Number.isFinite(value);
}

function isIsolatedTrendPoint(
  points: ReadonlyArray<PerformanceTrendChartPoint>,
  seriesKey: PerformanceSeriesKey,
  index: number,
): boolean {
  return (
    hasTrendValue(points[index], seriesKey) &&
    !hasTrendValue(points[index - 1], seriesKey) &&
    !hasTrendValue(points[index + 1], seriesKey)
  );
}

function createIsolatedTrendDot(
  points: ReadonlyArray<PerformanceTrendChartPoint>,
  seriesKey: PerformanceSeriesKey,
  color: string,
) {
  return function IsolatedTrendDot({
    cx,
    cy,
    index,
    payload,
  }: {
    cx?: number;
    cy?: number;
    index?: number;
    payload?: PerformanceTrendChartPoint;
  }) {
    const pointIndex =
      typeof index === "number"
        ? index
        : points.findIndex(
            (point) => point.timestampMs === payload?.timestampMs,
          );
    const dotKey = `${seriesKey}-${typeof index === "number" ? index : (payload?.timestampMs ?? "unknown")}`;

    if (
      pointIndex < 0 ||
      !isIsolatedTrendPoint(points, seriesKey, pointIndex) ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy)
    ) {
      return <g key={dotKey} />;
    }

    return <circle key={dotKey} cx={cx} cy={cy} r={3.2} fill={color} />;
  };
}

type PerformanceSeriesKey = "p50" | "p75" | "p95";

interface TrendConnectorLinePoint {
  x?: number;
  y?: number;
  value?: number | null;
  payload?: PerformanceTrendChartPoint;
}

interface TrendFormattedGraphicalItem {
  item?: {
    props?: {
      dataKey?: unknown;
    };
  };
  props?: {
    points?: TrendConnectorLinePoint[];
  };
}

function isPerformanceSeriesKey(value: unknown): value is PerformanceSeriesKey {
  return value === "p50" || value === "p75" || value === "p95";
}

function isRenderedTrendPoint(
  point: TrendConnectorLinePoint,
  seriesKey: PerformanceSeriesKey,
): point is TrendConnectorLinePoint & { x: number; y: number } {
  const value = point.value ?? point.payload?.[seriesKey];
  return (
    value != null &&
    Number.isFinite(value) &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

function gapConnectorPaths(
  points: TrendConnectorLinePoint[],
  seriesKey: PerformanceSeriesKey,
): string[] {
  const paths: string[] = [];
  let previous:
    | (TrendConnectorLinePoint & { x: number; y: number; index: number })
    | null = null;

  points.forEach((point, index) => {
    if (!isRenderedTrendPoint(point, seriesKey)) return;

    if (previous && index - previous.index > 1) {
      paths.push(
        `M${previous.x.toFixed(1)} ${previous.y.toFixed(1)}L${point.x.toFixed(
          1,
        )} ${point.y.toFixed(1)}`,
      );
    }

    previous = {
      ...point,
      index,
    };
  });

  return paths;
}

function TrendGapConnectorOverlay({
  visible,
  renderKey,
  formattedGraphicalItems,
}: {
  visible: boolean;
  renderKey: string;
  formattedGraphicalItems?: TrendFormattedGraphicalItem[];
}) {
  const connectorPaths =
    formattedGraphicalItems?.flatMap((item) => {
      const seriesKey = item.item?.props?.dataKey;
      if (!isPerformanceSeriesKey(seriesKey)) {
        return [];
      }

      const points = item.props?.points ?? [];
      return gapConnectorPaths(points, seriesKey).map((path, index) => ({
        key: `${seriesKey}-${index}`,
        path,
        seriesKey,
      }));
    }) ?? [];

  return (
    <AutoTransition
      as="g"
      className="performance-trend-gap-connectors"
      duration={0.22}
      type="fade"
      initial={false}
      presenceMode="wait"
    >
      {visible && connectorPaths.length > 0 ? (
        <g key={`gap-connectors-${renderKey}`}>
          {connectorPaths.map(({ key, path, seriesKey }) => (
            <path
              key={key}
              d={path}
              fill="none"
              stroke={PERFORMANCE_SERIES_COLORS[seriesKey]}
              strokeDasharray="5 6"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.58}
              strokeWidth={seriesKey === "p75" ? 2 : 1.6}
            />
          ))}
        </g>
      ) : (
        <g key={`gap-connectors-empty-${renderKey}`} />
      )}
    </AutoTransition>
  );
}

export const PerformanceTrendChart = memo(function PerformanceTrendChart({
  locale,
  activePanel,
  dataWindow,
  points,
  labels,
  metricThresholds,
  formatValue,
  className,
}: PerformanceTrendChartProps) {
  const chartPoints = useMemo(() => Array.from(points), [points]);
  const localeCode = intlLocale(locale);
  const axisTickFormatter = useMemo(
    () => tickDateFormat(localeCode, dataWindow.interval, dataWindow.timeZone),
    [dataWindow.interval, dataWindow.timeZone, localeCode],
  );
  const tooltipFormatter = useMemo(
    () =>
      tooltipDateFormat(localeCode, dataWindow.interval, dataWindow.timeZone),
    [dataWindow.interval, dataWindow.timeZone, localeCode],
  );
  const chartConfig = useMemo(
    () =>
      ({
        p50: {
          label: labels.p50,
          color: PERFORMANCE_SERIES_COLORS.p50,
        },
        p75: {
          label: labels.p75,
          color: PERFORMANCE_SERIES_COLORS.p75,
        },
        p95: {
          label: labels.p95,
          color: PERFORMANCE_SERIES_COLORS.p95,
        },
      }) satisfies ChartConfig,
    [labels.p50, labels.p75, labels.p95],
  );
  const [, domainMax] = useMemo(
    () => chartDomain(activePanel, chartPoints, metricThresholds),
    [activePanel, chartPoints, metricThresholds],
  );
  const xStart = chartPoints[0]?.timestampMs ?? dataWindow.from;
  const rawXEnd =
    chartPoints[chartPoints.length - 1]?.timestampMs ?? dataWindow.to;
  const xEnd = rawXEnd > xStart ? rawXEnd : xStart + 1;
  const trendRenderKey = useMemo(() => {
    const totals = chartPoints.reduce(
      (acc, point) => ({
        samples: acc.samples + point.samples,
        p50: acc.p50 + (point.p50 ?? 0),
        p75: acc.p75 + (point.p75 ?? 0),
        p95: acc.p95 + (point.p95 ?? 0),
      }),
      { samples: 0, p50: 0, p75: 0, p95: 0 },
    );
    return [
      activePanel,
      chartPoints.length,
      xStart,
      rawXEnd,
      totals.samples,
      totals.p50.toFixed(3),
      totals.p75.toFixed(3),
      totals.p95.toFixed(3),
    ].join(":");
  }, [activePanel, chartPoints, rawXEnd, xStart]);
  const [showGapConnectors, setShowGapConnectors] = useState(false);
  const isolatedDots = useMemo(
    () => ({
      p50: createIsolatedTrendDot(
        chartPoints,
        "p50",
        PERFORMANCE_SERIES_COLORS.p50,
      ),
      p75: createIsolatedTrendDot(
        chartPoints,
        "p75",
        PERFORMANCE_SERIES_COLORS.p75,
      ),
      p95: createIsolatedTrendDot(
        chartPoints,
        "p95",
        PERFORMANCE_SERIES_COLORS.p95,
      ),
    }),
    [chartPoints],
  );

  useEffect(() => {
    setShowGapConnectors(false);
    const timeoutId = globalThis.setTimeout(() => {
      setShowGapConnectors(true);
    }, PERFORMANCE_TREND_CONNECTOR_DELAY_MS);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [trendRenderKey]);

  return (
    <div className={cn("relative", className)}>
      <div
        className="pointer-events-none absolute top-3 right-3 bottom-16 left-20 rounded-none"
        style={{
          background: zoneBackground(activePanel, domainMax, metricThresholds),
        }}
      />
      <ChartContainer
        className="relative z-10 h-[360px] w-full aspect-auto"
        config={chartConfig}
      >
        <LineChart
          accessibilityLayer
          data={chartPoints}
          margin={{ left: 12, right: 12, top: 12, bottom: 4 }}
        >
          <TrendZones
            activePanel={activePanel}
            metricThresholds={metricThresholds}
          />
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="timestampMs"
            domain={[xStart, xEnd]}
            tickFormatter={(value) =>
              axisTickFormatter.format(new Date(Number(value ?? 0)))
            }
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={12}
          />
          <YAxis
            domain={[0, domainMax]}
            tickFormatter={(value) => formatValue(Number(value ?? 0))}
            tickLine={false}
            axisLine={false}
            width={activePanel === "cls" ? 64 : 80}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                className="min-w-[14rem]"
                indicator="line"
                labelFormatter={(value, payload) => {
                  const timestamp = Number(
                    payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                  );
                  return tooltipFormatter.format(new Date(timestamp));
                }}
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {String(name ?? "")}
                    </span>
                    <span className="font-mono text-foreground tabular-nums">
                      {formatValue(Number(value ?? 0))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend
            content={
              <ChartLegendContent className={PERFORMANCE_TREND_LEGEND_CLASS} />
            }
          />
          <Line
            type="monotone"
            dataKey="p50"
            name={labels.p50}
            legendType="rect"
            stroke={PERFORMANCE_SERIES_COLORS.p50}
            strokeWidth={2}
            dot={isolatedDots.p50}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive
            animationDuration={PERFORMANCE_TREND_ANIMATION_DURATION_MS}
          />
          <Line
            type="monotone"
            dataKey="p75"
            name={labels.p75}
            legendType="rect"
            stroke={PERFORMANCE_SERIES_COLORS.p75}
            strokeWidth={2.4}
            dot={isolatedDots.p75}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive
            animationDuration={PERFORMANCE_TREND_ANIMATION_DURATION_MS}
          />
          <Line
            type="monotone"
            dataKey="p95"
            name={labels.p95}
            legendType="rect"
            stroke={PERFORMANCE_SERIES_COLORS.p95}
            strokeWidth={2}
            dot={isolatedDots.p95}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive
            animationDuration={PERFORMANCE_TREND_ANIMATION_DURATION_MS}
          />
          <Customized
            component={
              <TrendGapConnectorOverlay
                visible={showGapConnectors}
                renderKey={trendRenderKey}
              />
            }
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
});
