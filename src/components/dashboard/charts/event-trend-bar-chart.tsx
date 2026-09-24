import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiSearchLine } from "@remixicon/react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  calculateChartYAxisWidth,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipIndicator,
  createChartNumberFormatter,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import { buildComplementaryOklchPalette } from "@/lib/dashboard/chart-colors";
import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type {
  EventsTrendData,
  EventTrendSeries,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";
export const EVENT_TREND_MAX_SERIES = 18;
const MAX_INITIAL_CHART_POINTS = 2_000;
const COMPARISON_DATA_PREFIX = "comparison:";
const COMPARISON_PATTERN_PREFIX = "event-comparison-pattern-";
export interface EventTrendChartSeries extends EventTrendSeries {
  displayLabel: string;
  color: string;
}
export interface EventTrendChartDataPoint {
  timestampMs: number;
  totalEvents: number;
  [seriesKey: string]: number;
}
interface EventTrendComparisonChartDataPoint extends EventTrendChartDataPoint {
  comparisonTimestampMs: number;
  comparisonTotalEvents: number;
}
export interface EventTrendLegendProps {
  data: ReadonlyArray<EventTrendChartDataPoint>;
  series: ReadonlyArray<EventTrendChartSeries>;
  hoveredPoint: EventTrendChartDataPoint | null;
  comparisonData?: ReadonlyArray<EventTrendChartDataPoint>;
  comparisonSeries?: ReadonlyArray<EventTrendChartSeries>;
  hoveredComparisonPoint?: EventTrendChartDataPoint | null;
  loading?: boolean;
  cumulativeLabel: string;
  totalLabel: string;
  locale: Locale;
  dateFormatter: Intl.DateTimeFormat;
  comparisonLabel?: string;
  onSelectEvent?: (eventName: string) => void;
}
export interface EventTrendBarChartProps {
  data: ReadonlyArray<EventTrendChartDataPoint>;
  series: ReadonlyArray<EventTrendChartSeries>;
  locale: Locale;
  from: number;
  to: number;
  interval: DashboardInterval;
  timeZone: string;
  loading?: boolean;
  emptyLabel: string;
  cumulativeLabel: string;
  totalLabel: string;
  currentPeriodLabel?: string;
  comparisonData?: ReadonlyArray<EventTrendChartDataPoint>;
  comparisonSeries?: ReadonlyArray<EventTrendChartSeries>;
  comparisonFrom?: number;
  comparisonTo?: number;
  comparisonLabel?: string;
  onSelectEvent?: (eventName: string) => void;
  className?: string;
}
export function createEventTrendChartSeries(
  series: ReadonlyArray<EventTrendSeries>,
  otherLabel: string,
): EventTrendChartSeries[] {
  const palette = buildComplementaryOklchPalette(
    series.filter((item) => !item.isOther).length,
  );
  let paletteIndex = 0;

  return series.map((item) => {
    if (item.isOther) {
      return {
        ...item,
        displayLabel: otherLabel,
        color: "var(--muted-foreground)",
      };
    }

    const color =
      palette[paletteIndex] ?? palette[palette.length - 1] ?? "#2dd4bf";
    paletteIndex += 1;

    return {
      ...item,
      displayLabel: item.label || item.eventName,
      color,
    };
  });
}
export function createEventTrendComparisonChartSeries(
  currentSeries: ReadonlyArray<EventTrendSeries>,
  comparisonSeries: ReadonlyArray<EventTrendSeries>,
  otherLabel: string,
): { current: EventTrendChartSeries[]; comparison: EventTrendChartSeries[] } {
  const currentByKey = new Map(currentSeries.map((item) => [item.key, item]));
  const comparisonByKey = new Map(
    comparisonSeries.map((item) => [item.key, item]),
  );
  const keys = [
    ...currentSeries.map((item) => item.key),
    ...comparisonSeries
      .map((item) => item.key)
      .filter((key) => !currentByKey.has(key)),
  ];
  const entries = keys.map((key) => {
    const current = currentByKey.get(key);
    const comparison = comparisonByKey.get(key);
    const source = current ?? comparison;
    return {
      key,
      eventName: current?.eventName ?? comparison?.eventName ?? key,
      label: current?.label || comparison?.label || source?.eventName || key,
      isOther: Boolean(current?.isOther || comparison?.isOther),
    };
  });
  const currentPalette = buildComplementaryOklchPalette(
    entries.filter((item) => !item.isOther).length,
  );
  let currentPaletteIndex = 0;

  const current = entries.map((item) => {
    const color = item.isOther
      ? "var(--muted-foreground)"
      : (currentPalette[currentPaletteIndex++] ?? "var(--color-chart-1)");
    const source = currentByKey.get(item.key);
    return {
      ...item,
      displayLabel: item.isOther ? otherLabel : item.label,
      color,
      events: source?.events ?? 0,
      sessions: source?.sessions ?? 0,
      visitors: source?.visitors ?? 0,
    };
  });
  const currentColorByKey = new Map(
    current.map((item) => [item.key, item.color]),
  );
  const comparison = entries.map((item) => {
    const source = comparisonByKey.get(item.key);
    const color = item.isOther
      ? "var(--muted-foreground)"
      : (currentColorByKey.get(item.key) ?? "var(--color-chart-1)");
    return {
      ...item,
      displayLabel: item.isOther ? otherLabel : item.label,
      color,
      events: source?.events ?? 0,
      sessions: source?.sessions ?? 0,
      visitors: source?.visitors ?? 0,
    };
  });

  return { current, comparison };
}
export function createEventTrendChartData(
  data: ReadonlyArray<EventsTrendData["data"][number]>,
  series: ReadonlyArray<EventTrendChartSeries>,
): EventTrendChartDataPoint[] {
  return data.map((point) => {
    const chartPoint: EventTrendChartDataPoint = {
      timestampMs: point.timestampMs,
      totalEvents: point.totalEvents,
    };
    for (const item of series) {
      chartPoint[item.key] = Number(point.eventsBySeries[item.key] ?? 0);
    }
    return chartPoint;
  });
}
function createEventTrendRenderData(
  data: ReadonlyArray<EventTrendChartDataPoint>,
  series: ReadonlyArray<EventTrendChartSeries>,
  from: number,
  to: number,
  interval: DashboardInterval,
  timeZone: string,
): EventTrendChartDataPoint[] {
  if (data.length >= 2) return [...data];

  if (data.length === 1) {
    return [
      data[0],
      {
        ...data[0],
        timestampMs: data[0].timestampMs + 1,
      },
    ];
  }

  const start = startOfZonedInterval(from, interval, timeZone);
  const end = startOfZonedInterval(to, interval, timeZone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return [];
  }

  const rows: EventTrendChartDataPoint[] = [];
  let timestampMs = start;
  for (
    let index = 0;
    index < MAX_INITIAL_CHART_POINTS && timestampMs <= end;
    index += 1
  ) {
    const row: EventTrendChartDataPoint = {
      timestampMs,
      totalEvents: 0,
    };
    for (const item of series) {
      row[item.key] = 0;
    }
    rows.push(row);

    const nextTimestampMs = addZonedInterval(timestampMs, interval, timeZone);
    if (!Number.isFinite(nextTimestampMs) || nextTimestampMs <= timestampMs) {
      break;
    }
    timestampMs = nextTimestampMs;
  }

  return rows;
}
function comparisonDataKey(key: string): string {
  return `${COMPARISON_DATA_PREFIX}${key}`;
}
function createEventTrendComparisonRenderData(
  data: ReadonlyArray<EventTrendChartDataPoint>,
  comparisonData: ReadonlyArray<EventTrendChartDataPoint>,
  series: ReadonlyArray<EventTrendChartSeries>,
  comparisonSeries: ReadonlyArray<EventTrendChartSeries>,
  from: number,
  to: number,
  comparisonFrom: number,
  comparisonTo: number,
  interval: DashboardInterval,
  timeZone: string,
): EventTrendComparisonChartDataPoint[] {
  const currentRenderData = createEventTrendRenderData(
    data,
    series,
    from,
    to,
    interval,
    timeZone,
  );
  const comparisonRenderData = createEventTrendRenderData(
    comparisonData,
    comparisonSeries,
    comparisonFrom,
    comparisonTo,
    interval,
    timeZone,
  );
  const length = Math.max(
    currentRenderData.length,
    comparisonRenderData.length,
  );

  return Array.from({ length }, (_, index) => {
    const currentPoint = currentRenderData[index];
    const comparisonPoint = comparisonRenderData[index];
    const point: EventTrendComparisonChartDataPoint = {
      timestampMs:
        currentPoint?.timestampMs ?? comparisonPoint?.timestampMs ?? 0,
      totalEvents: Math.max(0, Number(currentPoint?.totalEvents ?? 0)),
      comparisonTimestampMs:
        comparisonPoint?.timestampMs ?? currentPoint?.timestampMs ?? 0,
      comparisonTotalEvents: Math.max(
        0,
        Number(comparisonPoint?.totalEvents ?? 0),
      ),
    };

    for (const item of series) {
      point[item.key] = Math.max(0, Number(currentPoint?.[item.key] ?? 0));
    }
    for (const item of comparisonSeries) {
      point[comparisonDataKey(item.key)] = Math.max(
        0,
        Number(comparisonPoint?.[item.key] ?? 0),
      );
    }

    return point;
  });
}
function EventTrendTooltip({
  active,
  payload,
  dateFormatter,
  locale,
  series,
  activeSeriesKey,
  totalLabel,
  currentPeriodLabel,
  comparisonSeries,
  comparisonLabel,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    name?: string | number;
    value?: number | string;
    payload?: EventTrendChartDataPoint | EventTrendComparisonChartDataPoint;
  }>;
  dateFormatter: Intl.DateTimeFormat;
  locale: Locale;
  series: ReadonlyArray<EventTrendChartSeries>;
  activeSeriesKey: string | null;
  totalLabel: string;
  currentPeriodLabel?: string;
  comparisonSeries?: ReadonlyArray<EventTrendChartSeries>;
  comparisonLabel?: string;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row) return null;

  const activeSeries = activeSeriesKey
    ? series.find((item) => item.key === activeSeriesKey)
    : undefined;
  const activeValue = activeSeries
    ? Math.max(0, Number(row[activeSeries.key] ?? 0))
    : null;
  const hasComparison = Boolean(comparisonSeries?.length);
  const comparisonRow = row as EventTrendComparisonChartDataPoint;
  const comparisonItem = hasComparison
    ? comparisonSeries?.find((item) => item.key === activeSeriesKey)
    : undefined;
  const comparisonValue = comparisonItem
    ? Math.max(
        0,
        Number(comparisonRow[comparisonDataKey(comparisonItem.key)] ?? 0),
      )
    : null;
  const currentLabel = currentPeriodLabel ?? "Current period";
  const resolvedComparisonLabel = comparisonLabel ?? "Comparison";

  if (hasComparison) {
    const comparisonTotal = Math.max(
      0,
      Number(comparisonRow.comparisonTotalEvents ?? 0),
    );
    const totalRows = [
      {
        label: `${currentLabel} · ${totalLabel}`,
        color: "var(--color-chart-1)",
        value: Math.max(0, Number(row.totalEvents ?? 0)),
      },
      {
        label: `${resolvedComparisonLabel} · ${totalLabel}`,
        color: "var(--color-compare-chart-1)",
        value: comparisonTotal,
      },
    ];

    return (
      <div className="grid min-w-[220px] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
        <div className="font-medium text-foreground">
          {dateFormatter.format(new Date(Number(row.timestampMs ?? 0)))}
        </div>
        <div className="grid gap-1.5">
          {totalRows.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <ChartTooltipIndicator color={item.color} />
              <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {numberFormat(locale, item.value)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {activeSeries && activeValue !== null ? (
          <div className="mt-0.5 grid gap-1.5 border-t border-border/40 pt-1.5">
            <div className="flex items-center gap-2">
              <ChartTooltipIndicator color={activeSeries.color} />
              <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                <span className="truncate text-muted-foreground">
                  {currentLabel} · {activeSeries.displayLabel}
                </span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {numberFormat(locale, activeValue)}
                </span>
              </div>
            </div>
            {comparisonItem && comparisonValue !== null ? (
              <div className="flex items-center gap-2">
                <ChartTooltipIndicator color={comparisonItem.color} />
                <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                  <span className="truncate text-muted-foreground">
                    {resolvedComparisonLabel} · {comparisonItem.displayLabel}
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {numberFormat(locale, comparisonValue)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid min-w-[200px] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
      <div className="font-medium text-foreground">
        {dateFormatter.format(new Date(Number(row.timestampMs ?? 0)))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <ChartTooltipIndicator color="var(--color-primary)" />
          <span className="text-muted-foreground">{totalLabel}</span>
        </div>
        <span className="font-mono font-semibold tabular-nums text-foreground">
          {numberFormat(locale, Math.max(0, Number(row.totalEvents ?? 0)))}
        </span>
      </div>
      {activeSeries && activeValue !== null ? (
        <div className="mt-0.5 border-t border-border/40 pt-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <ChartTooltipIndicator color={activeSeries.color} />
              <span className="truncate text-muted-foreground">
                {activeSeries.displayLabel}
              </span>
            </div>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {numberFormat(locale, activeValue)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
export const EventTrendLegend = memo(function EventTrendLegend({
  data,
  series,
  hoveredPoint,
  comparisonData,
  comparisonSeries,
  loading = false,
  cumulativeLabel,
  totalLabel,
  locale,
  dateFormatter,
  comparisonLabel,
  onSelectEvent,
}: EventTrendLegendProps) {
  const totals = useMemo(() => {
    const nextTotals: Record<string, number> = {};
    for (const item of series) {
      nextTotals[item.key] = 0;
    }
    for (const point of data) {
      for (const item of series) {
        nextTotals[item.key] =
          (nextTotals[item.key] ?? 0) +
          Math.max(0, Number(point[item.key] ?? 0));
      }
    }
    return nextTotals;
  }, [data, series]);
  const hasComparison = Boolean(comparisonData && comparisonSeries?.length);

  return (
    <div className="flex flex-col gap-4 border-t border-border/40 pt-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">
          <AutoTransition>
            {hoveredPoint ? (
              <span
                key={`event-trend-hovered-${hoveredPoint.timestampMs}`}
                className="inline-flex items-center gap-1.5 font-medium text-primary"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-none bg-primary/60 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-none bg-primary" />
                </span>
                {dateFormatter.format(
                  new Date(Number(hoveredPoint.timestampMs ?? 0)),
                )}
              </span>
            ) : (
              <span key="event-trend-cumulative">{cumulativeLabel}</span>
            )}
          </AutoTransition>
        </span>
        {hasComparison ? (
          <span className="flex items-center gap-3 font-medium text-[11px] text-muted-foreground">
            <span>{totalLabel}</span>
            <span className="text-compare-primary">
              {comparisonLabel ?? "Comparison"}
            </span>
          </span>
        ) : (
          <span className="font-medium text-[11px] text-muted-foreground">
            {totalLabel}
          </span>
        )}
      </div>

      <AutoTransition
        initial={false}
        className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        aria-busy={loading}
        transitionKey={loading && series.length === 0 ? "loading" : "ready"}
        duration={0.2}
        presenceMode="wait"
      >
        {loading && series.length === 0
          ? Array.from({ length: 5 }, (_, index) => (
              <div
                key={`event-trend-legend-skeleton-${index}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-1"
                aria-hidden="true"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Skeleton className="size-2.5 shrink-0" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-4 w-12" />
              </div>
            ))
          : series.map((item) => {
              const currentValue = hoveredPoint
                ? Math.max(0, Number(hoveredPoint[item.key] ?? 0))
                : Math.max(0, Number(totals[item.key] ?? 0));
              const clickable = !item.isOther && Boolean(onSelectEvent);

              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!clickable}
                  onClick={() => onSelectEvent?.(item.eventName)}
                  className={cn(
                    "group/event-trend-item grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-none border-0 bg-transparent px-2.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                    clickable
                      ? "cursor-pointer hover:bg-accent/40"
                      : "cursor-default text-muted-foreground",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-none"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="truncate text-xs font-medium text-foreground">
                      {item.displayLabel}
                    </span>
                    {clickable ? (
                      <RiSearchLine className="size-[1.2em] shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/event-trend-item:opacity-100 group-focus-visible/event-trend-item:opacity-100" />
                    ) : null}
                  </div>
                  <AutoTransition>
                    <span
                      key={`${item.key}/${currentValue}`}
                      className="font-mono text-xs font-semibold tabular-nums text-foreground"
                    >
                      {numberFormat(locale, currentValue)}
                    </span>
                  </AutoTransition>
                </button>
              );
            })}
      </AutoTransition>
    </div>
  );
});
export const EventTrendBarChart = memo(function EventTrendBarChart({
  data,
  series,
  locale,
  from,
  to,
  interval,
  timeZone,
  loading = false,
  emptyLabel,
  cumulativeLabel,
  totalLabel,
  currentPeriodLabel,
  comparisonData,
  comparisonSeries,
  comparisonFrom = from,
  comparisonTo = to,
  comparisonLabel,
  onSelectEvent,
  className,
}: EventTrendBarChartProps) {
  const axisFormatter = useMemo(
    () => createChartAxisDateFormatter(locale, interval, timeZone, "regular"),
    [interval, locale, timeZone],
  );
  const tooltipFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [interval, locale, timeZone],
  );
  const hasComparison = Boolean(comparisonData && comparisonSeries?.length);
  const chartData = useMemo(
    () =>
      hasComparison
        ? createEventTrendComparisonRenderData(
            data,
            comparisonData ?? [],
            series,
            comparisonSeries ?? [],
            from,
            to,
            comparisonFrom,
            comparisonTo,
            interval,
            timeZone,
          )
        : createEventTrendRenderData(
            data,
            series,
            from,
            to,
            interval,
            timeZone,
          ),
    [
      comparisonData,
      comparisonFrom,
      comparisonSeries,
      comparisonTo,
      data,
      from,
      hasComparison,
      interval,
      series,
      timeZone,
      to,
    ],
  );
  const yAxisNumberFormatter = useMemo(
    () => createChartNumberFormatter(intlLocale(locale)),
    [locale],
  );
  const yAxisWidth = useMemo(() => {
    const labels = chartData.map((row) => {
      const currentTotal = Math.max(0, Number(row.totalEvents ?? 0));
      const comparisonTotal = hasComparison
        ? Math.max(
            0,
            Number(
              (row as EventTrendComparisonChartDataPoint)
                .comparisonTotalEvents ?? 0,
            ),
          )
        : 0;
      return yAxisNumberFormatter.format(
        Math.max(currentTotal, comparisonTotal),
      );
    });
    return calculateChartYAxisWidth(labels, 4);
  }, [chartData, hasComparison, yAxisNumberFormatter]);
  const chartConfig = useMemo(() => {
    const config = series.reduce((result, item) => {
      result[item.key] = {
        label: item.displayLabel,
        color: item.color,
      };
      return result;
    }, {} as ChartConfig);
    if (hasComparison) {
      for (const item of comparisonSeries ?? []) {
        config[comparisonDataKey(item.key)] = {
          label: item.displayLabel,
          color: item.color,
        };
      }
    }
    return config;
  }, [comparisonSeries, hasComparison, series]);
  const hasContent =
    series.length > 0 && (data.length > 0 || (comparisonData?.length ?? 0) > 0);
  const hoveredTimestampRef = useRef<number | null>(null);
  const hoveredSeriesKeyRef = useRef<string | null>(null);
  const [hoveredPoint, setHoveredPoint] =
    useState<EventTrendChartDataPoint | null>(null);
  const [hoveredSeriesKey, setHoveredSeriesKey] = useState<string | null>(null);

  useEffect(() => {
    hoveredTimestampRef.current = null;
    hoveredSeriesKeyRef.current = null;
    setHoveredPoint((current) => (current === null ? current : null));
    setHoveredSeriesKey((current) => (current === null ? current : null));
  }, [comparisonData, comparisonSeries, data, series]);

  const handleHoverPoint = useCallback(
    (point: EventTrendChartDataPoint | null) => {
      const nextTimestamp =
        point && Number.isFinite(point.timestampMs) ? point.timestampMs : null;
      if (hoveredTimestampRef.current === nextTimestamp) return;
      hoveredTimestampRef.current = nextTimestamp;
      setHoveredPoint(point);
    },
    [],
  );
  const handleHoverSeries = useCallback((seriesKey: string | null) => {
    if (hoveredSeriesKeyRef.current === seriesKey) return;
    hoveredSeriesKeyRef.current = seriesKey;
    setHoveredSeriesKey(seriesKey);
  }, []);
  const selectEvent = useCallback(
    (item: EventTrendChartSeries) => {
      if (item.isOther || !onSelectEvent) return;
      onSelectEvent(item.eventName);
    },
    [onSelectEvent],
  );
  const hoveredComparisonPoint = useMemo(() => {
    if (!hasComparison || !hoveredPoint) return null;

    const comparisonPoint = hoveredPoint as EventTrendComparisonChartDataPoint;
    const point: EventTrendChartDataPoint = {
      timestampMs:
        comparisonPoint.comparisonTimestampMs ?? comparisonPoint.timestampMs,
      totalEvents: comparisonPoint.comparisonTotalEvents ?? 0,
    };
    for (const item of comparisonSeries ?? []) {
      point[item.key] = Math.max(
        0,
        Number(comparisonPoint[comparisonDataKey(item.key)] ?? 0),
      );
    }
    return point;
  }, [comparisonSeries, hasComparison, hoveredPoint]);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="relative h-[320px]">
        {loading || hasContent ? (
          <ChartContainer
            className="h-[320px] w-full aspect-auto"
            config={chartConfig}
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              margin={{ left: 12, right: 12, top: 12 }}
              barCategoryGap={hasComparison ? "16%" : undefined}
              barGap={hasComparison ? 2 : 0}
              onMouseMove={(state) => {
                if (
                  state &&
                  state.activePayload &&
                  state.activePayload.length > 0
                ) {
                  const activePoint = state.activePayload[0]?.payload as
                    EventTrendChartDataPoint | undefined;
                  handleHoverPoint(activePoint ?? null);
                } else {
                  handleHoverPoint(null);
                  handleHoverSeries(null);
                }
              }}
              onMouseLeave={() => {
                handleHoverPoint(null);
                handleHoverSeries(null);
              }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="timestampMs"
                tickFormatter={(value) =>
                  axisFormatter.format(new Date(Number(value ?? 0)))
                }
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={12}
              />
              <YAxis
                width={yAxisWidth}
                tickFormatter={(value) =>
                  yAxisNumberFormatter.format(Number(value ?? 0))
                }
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tickMargin={4}
              />
              {hasComparison ? (
                <defs>
                  {(comparisonSeries ?? []).map((item, index) => (
                    <pattern
                      key={`${COMPARISON_PATTERN_PREFIX}${index}`}
                      id={`${COMPARISON_PATTERN_PREFIX}${index}`}
                      patternUnits="userSpaceOnUse"
                      width="8"
                      height="8"
                    >
                      <rect
                        width="8"
                        height="8"
                        fill={item.color}
                        fillOpacity={0.28}
                      />
                      <path
                        d="M-2 2L2 -2M0 8L8 0M6 10L10 6"
                        fill="none"
                        stroke={item.color}
                        strokeOpacity={0.76}
                        strokeWidth={1.25}
                      />
                    </pattern>
                  ))}
                </defs>
              ) : null}
              <ChartTooltip
                allowEscapeViewBox={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 20 }}
                content={
                  <EventTrendTooltip
                    activeSeriesKey={hoveredSeriesKey}
                    comparisonLabel={comparisonLabel}
                    comparisonSeries={
                      hasComparison ? comparisonSeries : undefined
                    }
                    currentPeriodLabel={currentPeriodLabel}
                    dateFormatter={tooltipFormatter}
                    locale={locale}
                    series={series}
                    totalLabel={totalLabel}
                  />
                }
              />
              {hasComparison
                ? [
                    ...(comparisonSeries ?? []).map((item, index) => (
                      <Bar
                        key={`comparison-${item.key}`}
                        dataKey={comparisonDataKey(item.key)}
                        stackId="comparison-events"
                        fill={`url(#${COMPARISON_PATTERN_PREFIX}${index})`}
                        stroke={item.color}
                        strokeWidth={1}
                        radius={0}
                        isAnimationActive
                        onMouseEnter={() => handleHoverSeries(item.key)}
                      />
                    )),
                    ...series.map((item) => (
                      <Bar
                        key={`current-${item.key}`}
                        dataKey={item.key}
                        stackId="current-events"
                        fill={item.color}
                        radius={0}
                        isAnimationActive
                        onClick={() => selectEvent(item)}
                        onMouseEnter={() => handleHoverSeries(item.key)}
                        className={cn(
                          !item.isOther && onSelectEvent && "cursor-pointer",
                        )}
                      />
                    )),
                  ]
                : series.map((item) => (
                    <Bar
                      key={item.key}
                      dataKey={item.key}
                      stackId="events"
                      fill={item.color}
                      radius={0}
                      isAnimationActive
                      onClick={() => selectEvent(item)}
                      onMouseEnter={() => handleHoverSeries(item.key)}
                      className={cn(
                        !item.isOther && onSelectEvent && "cursor-pointer",
                      )}
                    />
                  ))}
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {emptyLabel}
          </div>
        )}

        <AutoTransition
          initial={false}
          aria-hidden={!loading}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-muted-foreground"
          transitionKey={loading ? "loading" : "ready"}
          duration={0.2}
          presenceMode="sync"
        >
          {loading ? (
            <Spinner key="event-trend-loading-indicator" className="size-5" />
          ) : null}
        </AutoTransition>
      </div>

      <EventTrendLegend
        data={data}
        series={series}
        hoveredPoint={hoveredPoint}
        comparisonData={hasComparison ? comparisonData : undefined}
        comparisonSeries={hasComparison ? comparisonSeries : undefined}
        hoveredComparisonPoint={hoveredComparisonPoint}
        loading={loading}
        cumulativeLabel={cumulativeLabel}
        totalLabel={totalLabel}
        locale={locale}
        dateFormatter={tooltipFormatter}
        comparisonLabel={comparisonLabel}
        onSelectEvent={onSelectEvent}
      />
    </div>
  );
});
