import { type ComponentType, memo, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

import {
  calculateChartYAxisWidth,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  numberFormat,
  percentFormat,
  percentFormatWithOneDecimal,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

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
  comparisonRows?: ReadonlyArray<StackedBreakdownBarRow> | null;
  comparisonSeries?: ReadonlyArray<StackedBreakdownBarSeries>;
  locale: Locale;
  maxCategoryLabelLength?: number;
  stackId?: string;
  className?: string;
}

interface StackedBreakdownChartRow {
  category: string;
  categoryFullLabel: string;
  rowKey: string;
  [key: string]: string | number;
}

interface AlignedSeries {
  current: StackedBreakdownBarSeries[];
  comparison: StackedBreakdownBarSeries[];
}

const CURRENT_DATA_PREFIX = "current:";
const COMPARISON_DATA_PREFIX = "comparison:";
const VALUE_SUFFIX = ":value";
const COMPARISON_CHART_COLORS = [
  "var(--color-compare-chart-1)",
  "var(--color-compare-chart-2)",
  "var(--color-compare-chart-3)",
  "var(--color-compare-chart-4)",
  "var(--color-compare-chart-5)",
] as const;
const CURRENT_CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const;

function shortenLabel(label: string, maxLength: number): string {
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

function dataKey(period: "current" | "comparison", key: string): string {
  return `${period === "current" ? CURRENT_DATA_PREFIX : COMPARISON_DATA_PREFIX}${key}`;
}

function valueKey(period: "current" | "comparison", key: string): string {
  return `${dataKey(period, key)}${VALUE_SUFFIX}`;
}

function isMutedColor(color: string | undefined): boolean {
  return color === "var(--muted-foreground)";
}

function alignSeries(
  currentSeries: ReadonlyArray<StackedBreakdownBarSeries>,
  comparisonSeries: ReadonlyArray<StackedBreakdownBarSeries>,
  hasComparison: boolean,
): AlignedSeries {
  if (!hasComparison) {
    return { current: Array.from(currentSeries), comparison: [] };
  }

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

  return {
    current: keys.map((key, index) => {
      const current = currentByKey.get(key);
      const comparison = comparisonByKey.get(key);
      return {
        key,
        label: current?.label ?? comparison?.label ?? key,
        color:
          isMutedColor(current?.color) || isMutedColor(comparison?.color)
            ? "var(--muted-foreground)"
            : (current?.color ??
              CURRENT_CHART_COLORS[index % CURRENT_CHART_COLORS.length]),
        icon: current?.icon ?? comparison?.icon,
      };
    }),
    comparison: keys.map((key, index) => {
      const current = currentByKey.get(key);
      const comparison = comparisonByKey.get(key);
      return {
        key,
        label: comparison?.label ?? current?.label ?? key,
        color:
          isMutedColor(current?.color) || isMutedColor(comparison?.color)
            ? "var(--muted-foreground)"
            : COMPARISON_CHART_COLORS[index % COMPARISON_CHART_COLORS.length],
        icon: comparison?.icon ?? current?.icon,
      };
    }),
  };
}

function StackedBreakdownLegend({
  series,
  comparisonSeries,
}: {
  series: ReadonlyArray<StackedBreakdownBarSeries>;
  comparisonSeries: ReadonlyArray<StackedBreakdownBarSeries>;
}) {
  const comparisonByKey = new Map(
    comparisonSeries.map((item) => [item.key, item]),
  );

  return (
    <div className="flex flex-wrap items-center justify-start gap-x-4 gap-y-2 pt-4">
      {series.map((item) => {
        const comparison = comparisonByKey.get(item.key);
        const ItemIcon = item.icon;

        return (
          <div
            key={item.key}
            className="flex items-center gap-2 text-xs font-medium"
          >
            <span className="inline-flex shrink-0 items-center gap-0.5">
              <span
                className="size-2.5 shrink-0 rounded-none"
                style={{ backgroundColor: item.color }}
              />
              {comparison ? (
                <span
                  className="size-2.5 shrink-0 rounded-none"
                  style={{ backgroundColor: comparison.color }}
                />
              ) : null}
            </span>
            {ItemIcon ? (
              <ItemIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="text-muted-foreground">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StackedBreakdownTooltipValue({
  color,
  locale,
  share,
  value,
}: {
  color: string;
  locale: Locale;
  share: number;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
      <span
        className="size-2 shrink-0 rounded-none"
        style={{ backgroundColor: color }}
      />
      <span>
        {numberFormat(locale, value)} ·{" "}
        {percentFormatWithOneDecimal(locale, share)}
      </span>
    </span>
  );
}

export const StackedBreakdownBarChart = memo(function StackedBreakdownBarChart({
  rows,
  series,
  comparisonRows,
  comparisonSeries = [],
  locale,
  maxCategoryLabelLength = 18,
  stackId = "breakdown",
  className,
}: StackedBreakdownBarChartProps) {
  const hasComparison = comparisonRows != null;
  const alignedSeries = useMemo(
    () => alignSeries(series, comparisonSeries, hasComparison),
    [comparisonSeries, hasComparison, series],
  );
  const chartData = useMemo(() => {
    const currentByKey = new Map(rows.map((row) => [row.key, row]));
    const comparisonByKey = new Map(
      (comparisonRows ?? []).map((row) => [row.key, row]),
    );
    const rowKeys = [
      ...rows.map((row) => row.key),
      ...(comparisonRows ?? [])
        .map((row) => row.key)
        .filter((key) => !currentByKey.has(key)),
    ];

    return rowKeys.map<StackedBreakdownChartRow>((key) => {
      const currentRow = currentByKey.get(key);
      const comparisonRow = comparisonByKey.get(key);
      const label = currentRow?.label ?? comparisonRow?.label ?? key;
      const chartRow: StackedBreakdownChartRow = {
        category: shortenLabel(label, maxCategoryLabelLength),
        categoryFullLabel: label,
        rowKey: key,
      };

      const currentTotal = alignedSeries.current.reduce(
        (total, item) =>
          total + Math.max(0, Number(currentRow?.values[item.key] ?? 0)),
        0,
      );
      for (const item of alignedSeries.current) {
        const value = Math.max(0, Number(currentRow?.values[item.key] ?? 0));
        chartRow[dataKey("current", item.key)] =
          currentTotal > 0 ? value / currentTotal : 0;
        chartRow[valueKey("current", item.key)] = value;
      }

      if (hasComparison) {
        const comparisonTotal = alignedSeries.comparison.reduce(
          (total, item) =>
            total + Math.max(0, Number(comparisonRow?.values[item.key] ?? 0)),
          0,
        );
        for (const item of alignedSeries.comparison) {
          const value = Math.max(
            0,
            Number(comparisonRow?.values[item.key] ?? 0),
          );
          chartRow[dataKey("comparison", item.key)] =
            comparisonTotal > 0 ? value / comparisonTotal : 0;
          chartRow[valueKey("comparison", item.key)] = value;
        }
      }

      return chartRow;
    });
  }, [
    alignedSeries,
    comparisonRows,
    hasComparison,
    maxCategoryLabelLength,
    rows,
  ]);
  const chartConfig = useMemo(() => {
    const config = [
      ...alignedSeries.current,
      ...alignedSeries.comparison,
    ].reduce((result, item, index) => {
      const period =
        index < alignedSeries.current.length ? "current" : "comparison";
      result[dataKey(period, item.key)] = {
        label: item.label,
        color: item.color,
        icon: item.icon,
      };
      return result;
    }, {} as ChartConfig);
    return config;
  }, [alignedSeries]);
  const chartHeight = useMemo(
    () => Math.max(300, rows.length * 56 + 40),
    [rows.length],
  );
  const categoryAxisWidth = useMemo(
    () =>
      calculateChartYAxisWidth(
        chartData.map((row) => row.category),
        4,
      ),
    [chartData],
  );
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const rowOpacity = (rowKey: string) =>
    !hasComparison || hoveredRowKey === null || hoveredRowKey === rowKey
      ? 1
      : 0.28;

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <ChartContainer
        className="w-full aspect-auto"
        config={chartConfig}
        style={{ height: chartHeight }}
      >
        <BarChart
          accessibilityLayer
          data={chartData}
          layout="vertical"
          margin={{ top: 8, right: 12, bottom: 8, left: 12 }}
          barCategoryGap={hasComparison ? 4 : 12}
          barGap={hasComparison ? 2 : 0}
          onMouseMove={(state) => {
            const row = state?.activePayload?.[0]?.payload as
              StackedBreakdownChartRow | undefined;
            setHoveredRowKey(row?.rowKey ?? null);
          }}
          onMouseLeave={() => setHoveredRowKey(null)}
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
            cursor={
              hasComparison
                ? { fill: "var(--muted)", fillOpacity: 0.12 }
                : false
            }
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as
                StackedBreakdownChartRow | undefined;
              if (!active || !payload?.length || !row) return null;

              const visibleSeries = alignedSeries.current.filter((item) => {
                const currentShare = Number(
                  row[dataKey("current", item.key)] ?? 0,
                );
                const comparisonShare = hasComparison
                  ? Number(row[dataKey("comparison", item.key)] ?? 0)
                  : 0;
                return currentShare > 0 || comparisonShare > 0;
              });

              return (
                <div className="grid min-w-[18rem] gap-2 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
                  <div className="font-medium">{row.categoryFullLabel}</div>
                  <div className="grid gap-1.5">
                    {visibleSeries.map((item) => {
                      const currentShare = Number(
                        row[dataKey("current", item.key)] ?? 0,
                      );
                      const currentValue = Number(
                        row[valueKey("current", item.key)] ?? 0,
                      );
                      const comparison = alignedSeries.comparison.find(
                        (candidate) => candidate.key === item.key,
                      );
                      const comparisonShare = comparison
                        ? Number(row[dataKey("comparison", item.key)] ?? 0)
                        : 0;
                      const comparisonValue = comparison
                        ? Number(row[valueKey("comparison", item.key)] ?? 0)
                        : 0;

                      return (
                        <div
                          key={`${row.rowKey}-${item.key}`}
                          className="flex w-full items-center gap-3"
                        >
                          <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <span className="inline-flex shrink-0 items-center gap-0.5">
                              <span
                                className="size-2.5 shrink-0 rounded-none"
                                style={{ backgroundColor: item.color }}
                              />
                              {comparison ? (
                                <span
                                  className="size-2.5 shrink-0 rounded-none"
                                  style={{ backgroundColor: comparison.color }}
                                />
                              ) : null}
                            </span>
                            <span className="truncate text-muted-foreground">
                              {item.label}
                            </span>
                          </span>
                          <span className="grid shrink-0 grid-cols-[max-content_max-content] gap-x-3 text-right text-[11px]">
                            <StackedBreakdownTooltipValue
                              color={item.color}
                              locale={locale}
                              share={currentShare}
                              value={currentValue}
                            />
                            {comparison ? (
                              <StackedBreakdownTooltipValue
                                color={comparison.color}
                                locale={locale}
                                share={comparisonShare}
                                value={comparisonValue}
                              />
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }}
          />
          {alignedSeries.current.map((item) => (
            <Bar
              key={`current-${item.key}`}
              dataKey={dataKey("current", item.key)}
              stackId={hasComparison ? `${stackId}-current` : stackId}
              fill={item.color}
              radius={0}
            >
              {chartData.map((row) => (
                <Cell
                  key={`current-${row.rowKey}`}
                  opacity={rowOpacity(row.rowKey)}
                />
              ))}
            </Bar>
          ))}
          {hasComparison
            ? alignedSeries.comparison.map((item) => (
                <Bar
                  key={`comparison-${item.key}`}
                  dataKey={dataKey("comparison", item.key)}
                  stackId={`${stackId}-comparison`}
                  fill={item.color}
                  radius={0}
                  legendType="none"
                >
                  {chartData.map((row) => (
                    <Cell
                      key={`comparison-${row.rowKey}`}
                      opacity={rowOpacity(row.rowKey)}
                    />
                  ))}
                </Bar>
              ))
            : null}
        </BarChart>
      </ChartContainer>
      <StackedBreakdownLegend
        series={alignedSeries.current}
        comparisonSeries={alignedSeries.comparison}
      />
    </div>
  );
});
