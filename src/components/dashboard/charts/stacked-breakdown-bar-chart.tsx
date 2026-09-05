import { type ComponentType, memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  numberFormat,
  percentFormat,
  percentFormatWithOneDecimal,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";

export interface StackedBreakdownBarSeries {
  key: string;
  label: string;
  color: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface StackedBreakdownBarRow {
  key: string;
  label: string;
  values: Readonly<Record<string, number>>;
}

export interface StackedBreakdownBarChartProps {
  rows: ReadonlyArray<StackedBreakdownBarRow>;
  series: ReadonlyArray<StackedBreakdownBarSeries>;
  locale: Locale;
  categoryAxisWidth?: number;
  maxCategoryLabelLength?: number;
  stackId?: string;
  className?: string;
}

interface StackedBreakdownChartRow {
  category: string;
  categoryFullLabel: string;
  [key: string]: string | number;
}

function shortenLabel(label: string, maxLength: number): string {
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

export const StackedBreakdownBarChart = memo(function StackedBreakdownBarChart({
  rows,
  series,
  locale,
  categoryAxisWidth = 104,
  maxCategoryLabelLength = 18,
  stackId = "breakdown",
  className,
}: StackedBreakdownBarChartProps) {
  const chartConfig = useMemo(
    () =>
      series.reduce((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.color,
          icon: item.icon,
        };
        return config;
      }, {} as ChartConfig),
    [series],
  );
  const chartData = useMemo(
    () =>
      rows.map((row) => {
        const chartRow: StackedBreakdownChartRow = {
          category: shortenLabel(row.label, maxCategoryLabelLength),
          categoryFullLabel: row.label,
        };
        const total = Object.values(row.values).reduce(
          (sum, value) => sum + Math.max(0, Number(value ?? 0)),
          0,
        );

        for (const item of series) {
          const value = Math.max(0, Number(row.values[item.key] ?? 0));
          chartRow[item.key] = total > 0 ? value / total : 0;
          chartRow[`${item.key}Value`] = value;
        }

        return chartRow;
      }),
    [maxCategoryLabelLength, rows, series],
  );
  const chartHeight = useMemo(
    () => Math.max(300, rows.length * 56 + 40),
    [rows.length],
  );

  return (
    <ChartContainer
      className={className ?? "w-full aspect-auto"}
      config={chartConfig}
      style={{ height: chartHeight }}
    >
      <BarChart
        accessibilityLayer
        data={chartData}
        layout="vertical"
        margin={{ top: 8, right: 12, bottom: 8, left: 12 }}
        barCategoryGap={12}
      >
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 1]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => percentFormat(locale, Number(value ?? 0))}
        />
        <YAxis
          type="category"
          dataKey="category"
          tickLine={false}
          axisLine={false}
          width={categoryAxisWidth}
        />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as
              StackedBreakdownChartRow | undefined;
            if (!active || !payload?.length || !row) return null;

            const visibleSeries = series.filter(
              (item) => Number(row[item.key] ?? 0) > 0,
            );

            return (
              <div className="grid min-w-[18rem] gap-2 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
                <div className="font-medium">{row.categoryFullLabel}</div>
                <div className="grid gap-1.5">
                  {visibleSeries.map((item) => {
                    const share = Math.max(0, Number(row[item.key] ?? 0));
                    const value = Math.max(
                      0,
                      Number(row[`${item.key}Value`] ?? 0),
                    );

                    return (
                      <div
                        key={`${row.categoryFullLabel}-${item.key}`}
                        className="flex items-center gap-3"
                      >
                        <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          {item.icon ? (
                            <item.icon className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-none"
                              style={{ backgroundColor: item.color }}
                            />
                          )}
                          <span
                            className="truncate text-muted-foreground"
                            title={item.label}
                          >
                            {item.label}
                          </span>
                        </span>
                        <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                          {numberFormat(locale, value)} ·{" "}
                          {share < 0.1 ? "\u00a0" : ""}
                          {percentFormatWithOneDecimal(locale, share)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }}
        />
        <ChartLegend
          content={
            <ChartLegendContent className="pt-4 flex-wrap justify-start gap-x-4 gap-y-2" />
          }
        />
        {series.map((item) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            stackId={stackId}
            fill={`var(--color-${item.key})`}
            radius={0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
});
