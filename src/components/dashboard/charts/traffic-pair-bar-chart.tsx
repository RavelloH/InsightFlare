import { memo, useCallback, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  calculateChartYAxisWidth,
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipIndicator,
  createChartNumberFormatter,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import {
  useAnimationOnChartSwitch,
  useChartVisibility,
} from "@/hooks/use-chart-animation";
import {
  type ChartAxisDateFormat,
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";
import { intlLocale } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import {
  downsampleTrafficData,
  fillMissingTrafficData,
  safeChartCount,
} from "@/lib/dashboard/traffic-chart-data";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface TrafficPairBarChartProps {
  data: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }>;
  locale: Locale;
  timeZone: string;
  interval: DashboardInterval;
  viewsLabel: string;
  visitorsLabel: string;
  compact?: boolean;
  dataIsComplete?: boolean;
  axisDateFormat?: ChartAxisDateFormat;
  showLegend?: boolean;
  maxPoints?: number;
  loading?: boolean;
  className?: string;
  range?: {
    from: number;
    to: number;
  };
}

interface TrafficPairChartPoint {
  timestampMs: number;
  views: number;
  visitors: number;
  nonVisitorViews: number;
}

const TRAFFIC_PAIR_CHART_CONFIG = {
  visitors: {
    label: "visitors",
    color: "var(--color-chart-3)",
  },
  nonVisitorViews: {
    label: "views",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

const COMPACT_CHART_ANIMATION_DURATION = 220;

function createTrafficPairChartData(
  data: TrafficPairBarChartProps["data"],
  interval: DashboardInterval,
  timeZone: string,
  maxPoints?: number,
  range?: TrafficPairBarChartProps["range"],
  dataIsComplete = false,
): TrafficPairChartPoint[] {
  const completed = dataIsComplete
    ? data
    : fillMissingTrafficData(data, interval, timeZone, range);
  const normalized = downsampleTrafficData(
    completed,
    maxPoints ?? completed.length,
  );

  return normalized.map((point) => {
    const views = safeChartCount(point.views);
    const visitors = Math.min(safeChartCount(point.visitors), views);
    return {
      timestampMs: point.timestampMs,
      views,
      visitors,
      nonVisitorViews: Math.max(0, views - visitors),
    };
  });
}

function TrafficPairTooltip({
  active,
  payload,
  label,
  viewsLabel,
  visitorsLabel,
  tooltipFormatter,
  countFormatter,
}: TooltipProps<number, string> & {
  viewsLabel: string;
  visitorsLabel: string;
  tooltipFormatter: Intl.DateTimeFormat;
  countFormatter: Intl.NumberFormat;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as Partial<TrafficPairChartPoint> | null;
  const timestamp = Number(point?.timestampMs ?? label ?? 0);
  const views = safeChartCount(Number(point?.views ?? 0));
  const visitors = safeChartCount(Number(point?.visitors ?? 0));

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {tooltipFormatter.format(new Date(timestamp))}
      </div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color="var(--color-nonVisitorViews)" />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{viewsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countFormatter.format(views)}
            </span>
          </div>
        </div>
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color="var(--color-visitors)" />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{visitorsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countFormatter.format(visitors)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const TrafficPairRegularBarChart = memo(function TrafficPairRegularBarChart({
  data,
  locale,
  timeZone,
  interval,
  viewsLabel,
  visitorsLabel,
  compact = false,
  dataIsComplete = false,
  axisDateFormat = "compact",
  showLegend = false,
  maxPoints,
  loading = false,
  className,
  range,
}: TrafficPairBarChartProps) {
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility("0px");
  const [hasChartSize, setHasChartSize] = useState(false);
  const handleChartResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setHasChartSize(true);
  }, []);
  const chartData = useMemo(() => {
    return createTrafficPairChartData(
      data,
      interval,
      timeZone,
      maxPoints ?? (compact ? 72 : undefined),
      range,
      dataIsComplete,
    );
  }, [data, interval, timeZone, maxPoints, compact, range, dataIsComplete]);
  const config = useMemo(
    () => ({
      visitors: {
        ...TRAFFIC_PAIR_CHART_CONFIG.visitors,
        label: visitorsLabel,
      },
      nonVisitorViews: {
        ...TRAFFIC_PAIR_CHART_CONFIG.nonVisitorViews,
        label: viewsLabel,
      },
    }),
    [viewsLabel, visitorsLabel],
  );
  const tickFormatter = useMemo(
    () =>
      createChartAxisDateFormatter(locale, interval, timeZone, axisDateFormat),
    [locale, interval, timeZone, axisDateFormat],
  );
  const tooltipFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [locale, interval, timeZone],
  );
  const countFormatter = useMemo(
    () => new Intl.NumberFormat(intlLocale(locale)),
    [locale],
  );
  const pairChartDataKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${interval}:${compact ? "compact" : "regular"}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [interval, compact, chartData]);
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: pairChartDataKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });
  const yAxisValues = useMemo(
    () => chartData.map((point) => point.views),
    [chartData],
  );
  const yAxisNumberFormatter = useMemo(
    () => createChartNumberFormatter(intlLocale(locale)),
    [locale],
  );
  const yAxisWidth = useMemo(
    () =>
      calculateChartYAxisWidth(
        yAxisValues.map((value) => yAxisNumberFormatter.format(value)),
        4,
      ),
    [yAxisNumberFormatter, yAxisValues],
  );
  return (
    <div ref={containerRef} className="relative w-full">
      <ChartContainer
        className={cn(
          compact
            ? "h-4 w-full aspect-auto"
            : "h-[180px] w-full aspect-auto transition-opacity duration-200",
          "[&_.recharts-bar-rectangles]:transition-[filter] [&_.recharts-bar-rectangles]:duration-200 motion-reduce:[&_.recharts-bar-rectangles]:transition-none",
          compact || hasChartSize ? "opacity-100" : "opacity-0",
          loading
            ? "[&_.recharts-bar-rectangles]:brightness-50"
            : "[&_.recharts-bar-rectangles]:brightness-100",
          className,
        )}
        config={config}
        onChartResize={handleChartResize}
      >
        <BarChart
          data={chartData}
          margin={
            compact
              ? { left: 0, right: 0, top: 0, bottom: 0 }
              : { left: 0, right: 8 }
          }
          barGap={0}
        >
          {compact ? null : <CartesianGrid vertical={false} />}
          {compact ? null : (
            <XAxis
              dataKey="timestampMs"
              tickFormatter={(value) =>
                tickFormatter.format(new Date(Number(value ?? 0)))
              }
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={14}
            />
          )}
          {compact ? null : (
            <YAxis
              width={yAxisWidth}
              tickFormatter={(value) =>
                yAxisNumberFormatter.format(Number(value))
              }
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={4}
            />
          )}
          {compact ? null : (
            <ChartTooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 20 }}
              content={
                <TrafficPairTooltip
                  viewsLabel={viewsLabel}
                  visitorsLabel={visitorsLabel}
                  tooltipFormatter={tooltipFormatter}
                  countFormatter={countFormatter}
                />
              }
            />
          )}
          <Bar
            dataKey="visitors"
            stackId="traffic"
            fill="var(--color-visitors)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 220 : 0}
          />
          <Bar
            dataKey="nonVisitorViews"
            stackId="traffic"
            fill="var(--color-nonVisitorViews)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 220 : 0}
          />
          {showLegend && !compact ? (
            <ChartLegend content={<ChartLegendContent className="pt-4" />} />
          ) : null}
        </BarChart>
      </ChartContainer>
      {compact ? null : (
        <AutoTransition
          initial={false}
          aria-hidden={!loading && hasChartSize}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-muted-foreground"
          transitionKey={loading || !hasChartSize ? "loading" : "ready"}
          duration={0.2}
          presenceMode="sync"
        >
          {loading || !hasChartSize ? (
            <Spinner key="traffic-pair-loading-indicator" className="size-5" />
          ) : null}
        </AutoTransition>
      )}
    </div>
  );
});

const TrafficPairCompactBarChart = memo(function TrafficPairCompactBarChart({
  data,
  interval,
  timeZone,
  maxPoints,
  dataIsComplete = false,
  loading = false,
  className,
  range,
}: TrafficPairBarChartProps) {
  const chartData = useMemo(
    () =>
      createTrafficPairChartData(
        data,
        interval,
        timeZone,
        maxPoints ?? 72,
        range,
        dataIsComplete,
      ),
    [data, interval, timeZone, maxPoints, range, dataIsComplete],
  );

  return (
    <ChartContainer
      className={cn(
        "h-4 w-full aspect-auto [&_.recharts-bar-rectangles]:transition-[filter] [&_.recharts-bar-rectangles]:duration-200 motion-reduce:[&_.recharts-bar-rectangles]:transition-none",
        loading
          ? "[&_.recharts-bar-rectangles]:brightness-50"
          : "[&_.recharts-bar-rectangles]:brightness-100",
        className,
      )}
    >
      <BarChart
        data={chartData}
        margin={{ left: 0, right: 0, top: 0, bottom: 0 }}
        barGap={0}
      >
        <Bar
          dataKey="visitors"
          stackId="traffic"
          fill="var(--color-chart-3)"
          radius={0}
          isAnimationActive
          animationDuration={COMPACT_CHART_ANIMATION_DURATION}
        />
        <Bar
          dataKey="nonVisitorViews"
          stackId="traffic"
          fill="var(--color-chart-1)"
          radius={0}
          isAnimationActive
          animationDuration={COMPACT_CHART_ANIMATION_DURATION}
        />
      </BarChart>
    </ChartContainer>
  );
});

export const TrafficPairBarChart = memo(function TrafficPairBarChart(
  props: TrafficPairBarChartProps,
) {
  if (props.compact) {
    return <TrafficPairCompactBarChart {...props} />;
  }

  return <TrafficPairRegularBarChart {...props} />;
});
