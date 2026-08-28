import { memo, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { AutoResizer } from "@/components/ui/auto-resizer";
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
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface LatencyPercentileChartPoint {
  timestampMs: number;
  p50: number | null;
  p75: number | null;
  p95: number | null;
}

export interface LatencyPercentileChartLabels {
  p50: string;
  p75: string;
  p95: string;
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

const LATENCY_SERIES_COLORS = {
  p50: "var(--color-chart-1)",
  p75: "var(--color-chart-4)",
  p95: "var(--color-chart-5)",
} as const;
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
  const hasLatencyData = chartData.some(
    (point) => point.p50 !== null || point.p75 !== null || point.p95 !== null,
  );
  const bucketFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }),
    [locale, timeZone],
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
      ({
        p50: {
          label: labels.p50,
          color: LATENCY_SERIES_COLORS.p50,
        },
        p75: {
          label: labels.p75,
          color: LATENCY_SERIES_COLORS.p75,
        },
        p95: {
          label: labels.p95,
          color: LATENCY_SERIES_COLORS.p95,
        },
      }) satisfies ChartConfig,
    [labels.p50, labels.p75, labels.p95],
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
              <Line
                type="monotone"
                dataKey="p50"
                name={labels.p50}
                legendType="rect"
                stroke={LATENCY_SERIES_COLORS.p50}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="p75"
                name={labels.p75}
                legendType="rect"
                stroke={LATENCY_SERIES_COLORS.p75}
                strokeWidth={2.4}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                name={labels.p95}
                legendType="rect"
                stroke={LATENCY_SERIES_COLORS.p95}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
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
