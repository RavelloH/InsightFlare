import { memo, useCallback, useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  calculateChartYAxisWidth,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
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
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

import {
  createTrafficPairChartConfig,
  createTrafficPairChartData,
  createTrafficPairCountFormatter,
  type TrafficPairDataPoint,
  type TrafficPairRange,
  TrafficPairTooltip,
} from "./traffic-pair-chart";

export interface TrafficPairAreaChartProps {
  data: ReadonlyArray<TrafficPairDataPoint>;
  locale: Locale;
  timeZone: string;
  interval: DashboardInterval;
  viewsLabel: string;
  visitorsLabel: string;
  axisDateFormat?: ChartAxisDateFormat;
  showLegend?: boolean;
  maxPoints?: number;
  loading?: boolean;
  dataIsComplete?: boolean;
  className?: string;
  range?: TrafficPairRange;
}

const TRAFFIC_PAIR_AREA_ANIMATION_DURATION = 280;

export const TrafficPairAreaChart = memo(function TrafficPairAreaChart({
  data,
  locale,
  timeZone,
  interval,
  viewsLabel,
  visitorsLabel,
  axisDateFormat = "compact",
  showLegend = true,
  maxPoints,
  loading = false,
  dataIsComplete = false,
  className,
  range,
}: TrafficPairAreaChartProps) {
  const gradientId = useId().replace(/:/g, "");
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility("80px 0px");
  const [hasChartSize, setHasChartSize] = useState(false);
  const handleChartResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setHasChartSize(true);
  }, []);
  const chartData = useMemo(
    () =>
      createTrafficPairChartData(
        data,
        interval,
        timeZone,
        maxPoints,
        range,
        dataIsComplete,
      ),
    [data, interval, timeZone, maxPoints, range, dataIsComplete],
  );
  const config = useMemo(
    () => createTrafficPairChartConfig(viewsLabel, visitorsLabel),
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
    () => createTrafficPairCountFormatter(locale),
    [locale],
  );
  const yAxisNumberFormatter = useMemo(
    () => createChartNumberFormatter(intlLocale(locale)),
    [locale],
  );
  const yAxisWidth = useMemo(
    () =>
      calculateChartYAxisWidth(
        chartData.map((point) => yAxisNumberFormatter.format(point.views)),
        4,
      ),
    [chartData, yAxisNumberFormatter],
  );
  const areaChartDataKey = useMemo(
    () =>
      `${interval}:${chartData
        .map((point) => `${point.timestampMs}:${point.views}:${point.visitors}`)
        .join("|")}`,
    [interval, chartData],
  );
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: areaChartDataKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="relative w-full">
      <ChartContainer
        config={config}
        className={cn(
          "h-[280px] w-full aspect-auto transition-opacity duration-200",
          hasChartSize ? "opacity-100" : "opacity-0",
          loading
            ? "[&_.recharts-area-area]:brightness-50"
            : "[&_.recharts-area-area]:brightness-100",
          className,
        )}
        onChartResize={handleChartResize}
      >
        <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8 }}>
          <defs>
            <linearGradient
              id={`${gradientId}-visitors`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-visitors)"
                stopOpacity={0.8}
              />
              <stop
                offset="95%"
                stopColor="var(--color-visitors)"
                stopOpacity={0.12}
              />
            </linearGradient>
            <linearGradient
              id={`${gradientId}-views`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-nonVisitorViews)"
                stopOpacity={0.72}
              />
              <stop
                offset="95%"
                stopColor="var(--color-nonVisitorViews)"
                stopOpacity={0.08}
              />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestampMs"
            tickFormatter={(value) =>
              tickFormatter.format(new Date(Number(value ?? 0)))
            }
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
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
          <ChartTooltip
            cursor={false}
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
          <Area
            dataKey="visitors"
            type="step"
            stackId="traffic"
            stroke="var(--color-visitors)"
            fill={`url(#${gradientId}-visitors)`}
            strokeWidth={1.5}
            dot={false}
            activeDot={{
              r: 2,
              stroke: "var(--color-visitors)",
              fill: "var(--color-visitors)",
            }}
            isAnimationActive={isAnimationActive}
            animationDuration={
              isAnimationActive ? TRAFFIC_PAIR_AREA_ANIMATION_DURATION : 0
            }
          />
          <Area
            dataKey="nonVisitorViews"
            type="step"
            stackId="traffic"
            stroke="var(--color-nonVisitorViews)"
            fill={`url(#${gradientId}-views)`}
            strokeWidth={1.5}
            dot={false}
            activeDot={{
              r: 2,
              stroke: "var(--color-nonVisitorViews)",
              fill: "var(--color-nonVisitorViews)",
            }}
            isAnimationActive={isAnimationActive}
            animationDuration={
              isAnimationActive ? TRAFFIC_PAIR_AREA_ANIMATION_DURATION : 0
            }
          />
          {showLegend ? <ChartLegend content={<ChartLegendContent />} /> : null}
        </AreaChart>
      </ChartContainer>
      <AutoTransition
        initial={false}
        aria-hidden={!loading && hasChartSize}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center text-muted-foreground",
          showLegend ? "bottom-8" : "bottom-0",
        )}
        transitionKey={loading || !hasChartSize ? "loading" : "ready"}
        duration={0.2}
        presenceMode="sync"
      >
        {loading || !hasChartSize ? (
          <Spinner
            key="traffic-pair-area-loading-indicator"
            className="size-5"
          />
        ) : null}
      </AutoTransition>
    </div>
  );
});
