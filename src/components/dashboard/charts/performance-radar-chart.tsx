import { memo, useMemo } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
} from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export type PerformanceRadarMetricKey =
  "duration" | "engagement" | "depth" | "loyalty" | "frequency" | "traffic";

export const PERFORMANCE_RADAR_METRIC_KEYS = [
  "duration",
  "engagement",
  "depth",
  "loyalty",
  "frequency",
  "traffic",
] as const satisfies readonly PerformanceRadarMetricKey[];

export type PerformanceRadarMetrics = Record<PerformanceRadarMetricKey, number>;

export type PerformanceRadarMetricLabels = Record<
  PerformanceRadarMetricKey,
  string
>;

interface PerformanceRadarPoint {
  metric: string;
  metricKey: PerformanceRadarMetricKey;
  value: number;
}

export interface PerformanceRadarChartProps {
  itemLabel: string;
  metrics: PerformanceRadarMetrics;
  maxByMetric: PerformanceRadarMetrics;
  metricLabels: PerformanceRadarMetricLabels;
  color: string;
  locale: Locale;
  className?: string;
}

function formatRawMetric(
  locale: Locale,
  metricKey: PerformanceRadarMetricKey,
  value: number,
): string {
  switch (metricKey) {
    case "duration":
      return durationFormat(locale, value);
    case "engagement":
    case "loyalty":
    case "traffic":
      return percentFormat(locale, value);
    case "depth":
    case "frequency":
      return numberFormat(locale, Number(value.toFixed(1)));
  }
}

function buildNormalizedPoints(
  metrics: PerformanceRadarMetrics,
  maxByMetric: PerformanceRadarMetrics,
  metricLabels: PerformanceRadarMetricLabels,
): PerformanceRadarPoint[] {
  return PERFORMANCE_RADAR_METRIC_KEYS.map((key) => {
    const max = maxByMetric[key];
    return {
      metric: metricLabels[key],
      metricKey: key,
      value: max > 0 ? Math.round((metrics[key] / max) * 100) : 0,
    };
  });
}

export const PerformanceRadarChart = memo(function PerformanceRadarChart({
  itemLabel,
  metrics,
  maxByMetric,
  metricLabels,
  color,
  locale,
  className,
}: PerformanceRadarChartProps) {
  const points = useMemo(
    () => buildNormalizedPoints(metrics, maxByMetric, metricLabels),
    [maxByMetric, metricLabels, metrics],
  );
  const chartConfig = useMemo<ChartConfig>(
    () => ({ value: { label: itemLabel, color } }),
    [color, itemLabel],
  );

  return (
    <ChartContainer
      config={chartConfig}
      className={cn("aspect-square w-full", className)}
    >
      <RadarChart data={points} cx="50%" cy="50%" outerRadius="70%">
        <PolarGrid />
        <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10 }} />
        <PolarRadiusAxis
          angle={30}
          domain={[0, 100]}
          tick={false}
          axisLine={false}
        />
        <Radar
          name={itemLabel}
          dataKey="value"
          stroke={color}
          fill={color}
          fillOpacity={0.15}
        />
        <ChartTooltip
          content={({ active, label, payload }) => {
            if (!active || !payload?.length) return null;
            const point = points.find((entry) => entry.metric === label);
            if (!point) return null;

            return (
              <div className="grid min-w-[8rem] gap-0.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                <div className="font-medium">{label}</div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{itemLabel}</span>
                  <span className="font-mono font-medium tabular-nums">
                    {formatRawMetric(
                      locale,
                      point.metricKey,
                      metrics[point.metricKey],
                    )}
                  </span>
                </div>
              </div>
            );
          }}
        />
      </RadarChart>
    </ChartContainer>
  );
});
