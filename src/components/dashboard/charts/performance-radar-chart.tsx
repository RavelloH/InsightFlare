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
  ChartTooltipIndicator,
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
  comparisonValue?: number;
}

export interface PerformanceRadarChartProps {
  itemLabel: string;
  metrics: PerformanceRadarMetrics;
  maxByMetric: PerformanceRadarMetrics;
  metricLabels: PerformanceRadarMetricLabels;
  color: string;
  locale: Locale;
  className?: string;
  comparisonMetrics?: PerformanceRadarMetrics;
  comparisonColor?: string;
  comparisonLabel?: string;
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
  comparisonMetrics?: PerformanceRadarMetrics,
): PerformanceRadarPoint[] {
  return PERFORMANCE_RADAR_METRIC_KEYS.map((key) => {
    const max = maxByMetric[key];
    return {
      metric: metricLabels[key],
      metricKey: key,
      value: max > 0 ? Math.round((metrics[key] / max) * 100) : 0,
      ...(comparisonMetrics
        ? {
            comparisonValue:
              max > 0 ? Math.round((comparisonMetrics[key] / max) * 100) : 0,
          }
        : {}),
    };
  });
}

export function buildPerformanceRadarMaxByMetric(
  metrics: readonly PerformanceRadarMetrics[],
): PerformanceRadarMetrics {
  const result = {} as PerformanceRadarMetrics;
  for (const key of PERFORMANCE_RADAR_METRIC_KEYS) {
    result[key] = Math.max(...metrics.map((item) => item[key]), 0);
  }
  return result;
}

function PerformanceRadarTooltip({
  active,
  payload,
  itemLabel,
  metrics,
  comparisonMetrics,
  comparisonLabel,
  color,
  comparisonColor,
  locale,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  itemLabel: string;
  metrics: PerformanceRadarMetrics;
  comparisonMetrics?: PerformanceRadarMetrics;
  comparisonLabel: string;
  color: string;
  comparisonColor: string;
  locale: Locale;
}) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as PerformanceRadarPoint | undefined;
  if (!point) return null;

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.metric}</div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color={color} />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{itemLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatRawMetric(
                locale,
                point.metricKey,
                metrics[point.metricKey],
              )}
            </span>
          </div>
        </div>
        {comparisonMetrics ? (
          <div className="flex w-full items-center gap-2">
            <ChartTooltipIndicator color={comparisonColor} />
            <div className="flex flex-1 items-center justify-between gap-3 leading-none">
              <span className="text-muted-foreground">{comparisonLabel}</span>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatRawMetric(
                  locale,
                  point.metricKey,
                  comparisonMetrics[point.metricKey],
                )}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const PerformanceRadarChart = memo(function PerformanceRadarChart({
  itemLabel,
  metrics,
  maxByMetric,
  metricLabels,
  color,
  locale,
  className,
  comparisonMetrics,
  comparisonColor = "var(--color-compare-primary)",
  comparisonLabel = "Comparison",
}: PerformanceRadarChartProps) {
  const points = useMemo(
    () =>
      buildNormalizedPoints(
        metrics,
        maxByMetric,
        metricLabels,
        comparisonMetrics,
      ),
    [comparisonMetrics, maxByMetric, metricLabels, metrics],
  );
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      value: { label: itemLabel, color },
      ...(comparisonMetrics
        ? {
            comparisonValue: {
              label: comparisonLabel,
              color: comparisonColor,
            },
          }
        : {}),
    }),
    [color, comparisonColor, comparisonLabel, comparisonMetrics, itemLabel],
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
          fillOpacity={comparisonMetrics ? 0.1 : 0.15}
        />
        {comparisonMetrics ? (
          <Radar
            name={comparisonLabel}
            dataKey="comparisonValue"
            stroke={comparisonColor}
            fill={comparisonColor}
            fillOpacity={0.04}
          />
        ) : null}
        <ChartTooltip
          cursor={false}
          content={
            <PerformanceRadarTooltip
              itemLabel={itemLabel}
              metrics={metrics}
              comparisonMetrics={comparisonMetrics}
              comparisonLabel={comparisonLabel}
              color={color}
              comparisonColor={comparisonColor}
              locale={locale}
            />
          }
        />
      </RadarChart>
    </ChartContainer>
  );
});
