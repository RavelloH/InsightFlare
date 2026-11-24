import { memo, useMemo } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@insightflare/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { cn } from "../utils/cn";
import { intlLocale } from "./chart-format";
import type { ChartLocale as Locale } from "./types";

export type LatencyPercentileKey = "p50" | "p75" | "p95" | "p99";

export interface LatencyPercentileChartPoint {
  timestampMs: number;
  p50: number | null;
  p75?: number | null;
  p95: number | null;
  p99?: number | null;
}

/** A series is drawn only when its label is provided. */
export interface LatencyPercentileChartLabels {
  p50: string;
  p75?: string;
  p95: string;
  p99?: string;
}

export interface LatencyPercentileChartProps {
  data: ReadonlyArray<LatencyPercentileChartPoint>;
  labels: LatencyPercentileChartLabels;
  locale: Locale;
  timeZone: string;
  formatValue: (value: number | null) => string;
  loading?: boolean;
  loadingLabel: string;
  emptyLabel: string;
  className?: string;
}

const LATENCY_SERIES_COLORS: Record<LatencyPercentileKey, string> = {
  p50: "var(--color-chart-1)",
  p75: "var(--color-chart-4)",
  p95: "var(--color-chart-5)",
  p99: "var(--color-chart-secondary-3)",
};
const LATENCY_SERIES_WIDTHS: Record<LatencyPercentileKey, number> = {
  p50: 2,
  p75: 2.4,
  p95: 2,
  p99: 1.6,
};
const LATENCY_KEYS: readonly LatencyPercentileKey[] = [
  "p50",
  "p75",
  "p95",
  "p99",
];
const MULTI_DAY_SPAN_MS = 36 * 60 * 60 * 1000;
const LATENCY_LEGEND_CLASS =
  "pt-6 flex-wrap justify-center gap-x-4 gap-y-2 [&>div>div]:h-2.5 [&>div>div]:w-2.5 [&>div>div]:shrink-0 [&>div>div]:rounded-none";

export const LatencyPercentileChart = memo(function LatencyPercentileChart({
  data,
  labels,
  locale,
  timeZone,
  formatValue,
  loading = false,
  loadingLabel,
  emptyLabel,
  className,
}: LatencyPercentileChartProps) {
  const chartData = useMemo(() => Array.from(data), [data]);
  const seriesKeys = useMemo(
    () => LATENCY_KEYS.filter((key) => Boolean(labels[key])),
    [labels],
  );
  const hasLatencyData = chartData.some((point) =>
    seriesKeys.some((key) => point[key] !== null && point[key] !== undefined),
  );
  const multiDay = useMemo(() => {
    if (chartData.length < 2) return false;
    const stamps = chartData.map((point) => point.timestampMs);
    return Math.max(...stamps) - Math.min(...stamps) > MULTI_DAY_SPAN_MS;
  }, [chartData]);
  const bucketFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(
        intlLocale(locale),
        multiDay
          ? { month: "numeric", day: "numeric", timeZone }
          : { hour: "2-digit", minute: "2-digit", timeZone },
      ),
    [locale, multiDay, timeZone],
  );
  const tooltipFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }),
    [locale, timeZone],
  );
  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        seriesKeys.map((key) => [
          key,
          { label: labels[key], color: LATENCY_SERIES_COLORS[key] },
        ]),
      ) satisfies ChartConfig,
    [labels, seriesKeys],
  );

  return (
    <AutoResizer initial>
      <AutoTransition
        transitionKey={hasLatencyData ? "chart" : loading ? "loading" : "empty"}
        initial={false}
        duration={0.2}
        type="fade"
      >
        {hasLatencyData ? (
          <ChartContainer
            key="chart"
            className={cn("h-[320px] w-full aspect-auto", className)}
            config={chartConfig}
          >
            <LineChart
              accessibilityLayer
              data={chartData}
              margin={{ left: 12, right: 12, top: 12, bottom: 4 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="timestampMs"
                tickFormatter={(value) =>
                  bucketFormatter.format(new Date(Number(value ?? 0)))
                }
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={12}
              />
              <YAxis
                tickFormatter={(value) => formatValue(Number(value ?? 0))}
                tickLine={false}
                axisLine={false}
                width={74}
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
                  <ChartLegendContent className={LATENCY_LEGEND_CLASS} />
                }
              />
              {seriesKeys.map((key) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={labels[key]}
                  legendType="rect"
                  stroke={LATENCY_SERIES_COLORS[key]}
                  strokeWidth={LATENCY_SERIES_WIDTHS[key]}
                  strokeDasharray={key === "p99" ? "4 3" : undefined}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        ) : (
          <div
            key={loading ? "loading" : "empty"}
            className={cn(
              "flex h-[320px] items-center justify-center text-sm text-muted-foreground",
              className,
            )}
          >
            {loading ? loadingLabel : emptyLabel}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});
