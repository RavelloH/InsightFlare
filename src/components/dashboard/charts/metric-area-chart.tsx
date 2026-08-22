import { memo, useId, useMemo } from "react";
import { Area, AreaChart } from "recharts";

import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
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
  const areaChartSwitchKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${label}:${animationKey}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [animationKey, chartData, label]);
  const isAreaAnimationActive = useAnimationOnChartSwitch({
    switchKey: areaChartSwitchKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="h-full w-full">
      <div className="relative h-full w-full">
        <ChartContainer className="h-full w-full aspect-auto">
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.36} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <ChartTooltip
              cursor={{ stroke: color, strokeOpacity: 0.28, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const item = payload[0]?.payload as
                  | { timestampMs?: number; value?: number }
                  | undefined;
                const timestampMs = Number(item?.timestampMs ?? 0);
                const value = Number(item?.value ?? 0);

                return (
                  <div className="rounded-none border border-border/50 bg-background px-2 py-1 text-[11px] shadow-xl">
                    <p className="text-muted-foreground">
                      {dateFormatter.format(new Date(timestampMs))}
                    </p>
                    <p className="font-mono text-foreground">
                      {label}: {formatValue(value)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="linear"
              dataKey="value"
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2, stroke: color, fill: color }}
              isAnimationActive={isAreaAnimationActive}
              animationDuration={isAreaAnimationActive ? 280 : 0}
            />
          </AreaChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-card via-card/80 to-transparent" />
      </div>
    </div>
  );
});
