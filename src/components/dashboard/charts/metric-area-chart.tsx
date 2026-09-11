import { memo, useId, useMemo } from "react";
import { Area, AreaChart, type TooltipProps } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipIndicator,
} from "@/components/ui/chart";
import {
  useAnimationOnChartSwitch,
  useChartVisibility,
} from "@/hooks/use-chart-animation";
import { createChartTooltipDateFormatter } from "@/lib/dashboard/chart-time";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";

export interface MetricAreaPoint {
  timestampMs: number;
  value: number;
}

export interface MetricAreaChartProps {
  points: ReadonlyArray<MetricAreaPoint>;
  color: string;
  locale: Locale;
  timeZone: string;
  interval: DashboardInterval;
  label: string;
  formatValue: (value: number) => string;
  animationKey: string;
  comparisonPoints?: ReadonlyArray<MetricAreaPoint>;
  comparisonColor?: string;
  comparisonLabel?: string;
}

function MetricAreaTooltip({
  active,
  payload,
  label,
  labelText,
  comparisonLabel,
  dateFormatter,
  formatValue,
  color,
  comparisonColor,
}: TooltipProps<number, string> & {
  labelText: string;
  comparisonLabel: string;
  dateFormatter: Intl.DateTimeFormat;
  formatValue: (value: number) => string;
  color: string;
  comparisonColor: string;
}) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as {
    timestampMs?: number;
    value?: number;
    comparisonValue?: number | null;
  } | null;
  const timestamp = Number(point?.timestampMs ?? label ?? 0);
  const value = Number(point?.value ?? 0);
  const comparisonValue = point?.comparisonValue;

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {dateFormatter.format(new Date(timestamp))}
      </div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color={color} />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{labelText}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatValue(value)}
            </span>
          </div>
        </div>
        {typeof comparisonValue === "number" ? (
          <div className="flex w-full items-center gap-2">
            <ChartTooltipIndicator color={comparisonColor} />
            <div className="flex flex-1 items-center justify-between gap-3 leading-none">
              <span className="text-muted-foreground">{comparisonLabel}</span>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatValue(comparisonValue)}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const MetricAreaChart = memo(function MetricAreaChart({
  points,
  color,
  locale,
  timeZone,
  interval,
  label,
  formatValue,
  animationKey,
  comparisonPoints,
  comparisonColor = color,
  comparisonLabel = "Comparison",
}: MetricAreaChartProps) {
  const gradientId = useId().replace(/:/g, "");
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility("80px 0px");
  const dateFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [locale, interval, timeZone],
  );
  const chartData = useMemo(() => {
    const normalized = points.map((point, index) => ({
      index,
      timestampMs: Number.isFinite(point.timestampMs) ? point.timestampMs : 0,
      value: Number.isFinite(point.value) ? Math.max(0, point.value) : 0,
    }));

    if (normalized.length >= 2) return normalized;
    if (normalized.length === 1) {
      const first = normalized[0] ?? { index: 0, value: 0, timestampMs: 0 };
      return [
        first,
        {
          index: 1,
          value: first.value,
          timestampMs: first.timestampMs + 1,
        },
      ];
    }
    return [
      { index: 0, value: 0, timestampMs: 0 },
      { index: 1, value: 0, timestampMs: 1 },
    ];
  }, [points]);
  const chartDataWithComparison = useMemo(() => {
    if (!comparisonPoints) return chartData;

    return chartData.map((point, index) => ({
      ...point,
      comparisonValue: Number.isFinite(comparisonPoints[index]?.value)
        ? Math.max(0, comparisonPoints[index]?.value ?? 0)
        : null,
    }));
  }, [chartData, comparisonPoints]);
  const areaChartSwitchKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    const comparisonFirstValue = comparisonPoints?.[0]?.value ?? 0;
    const comparisonLastValue =
      comparisonPoints?.[comparisonPoints.length - 1]?.value ?? 0;
    return `${label}:${animationKey}:${chartData.length}:${firstTimestamp}:${lastTimestamp}:${comparisonPoints?.length ?? 0}:${comparisonFirstValue}:${comparisonLastValue}`;
  }, [animationKey, chartData, comparisonPoints, label]);
  const isAreaAnimationActive = useAnimationOnChartSwitch({
    switchKey: areaChartSwitchKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="h-full w-full">
      <div className="relative h-full w-full">
        <ChartContainer
          className="h-full w-full aspect-auto"
          config={{
            value: { label, color },
            comparisonValue: {
              label: comparisonLabel,
              color: comparisonColor,
            },
          }}
        >
          <AreaChart
            data={chartDataWithComparison}
            margin={{ top: 12, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.36} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <ChartTooltip
              cursor={false}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 20 }}
              content={
                <MetricAreaTooltip
                  labelText={label}
                  comparisonLabel={comparisonLabel}
                  dateFormatter={dateFormatter}
                  formatValue={formatValue}
                  color={color}
                  comparisonColor={comparisonColor}
                />
              }
            />
            <Area
              type="linear"
              dataKey="value"
              name={label}
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2, stroke: color, fill: color }}
              isAnimationActive={isAreaAnimationActive}
              animationDuration={isAreaAnimationActive ? 280 : 0}
            />
            {comparisonPoints ? (
              <Area
                type="linear"
                dataKey="comparisonValue"
                name={comparisonLabel}
                stroke={comparisonColor}
                fill="none"
                strokeWidth={1.5}
                dot={false}
                connectNulls
                activeDot={{
                  r: 2,
                  stroke: comparisonColor,
                  fill: comparisonColor,
                }}
                isAnimationActive={isAreaAnimationActive}
                animationDuration={isAreaAnimationActive ? 280 : 0}
              />
            ) : null}
          </AreaChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-card via-card/80 to-transparent" />
      </div>
    </div>
  );
});
