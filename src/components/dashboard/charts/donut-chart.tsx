import { memo, useCallback, useMemo, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  numberFormat,
  percentFormatWithOneDecimal,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface DonutChartDataPoint {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
}

export interface DonutChartProps {
  data: ReadonlyArray<DonutChartDataPoint>;
  comparisonData?: ReadonlyArray<DonutChartDataPoint> | null;
  currentLabel?: string;
  comparisonLabel?: string;
  locale: Locale;
  valueLabel: string;
  innerRadius?: number | string;
  outerRadius?: number | string;
  className?: string;
  highlightedKey?: string | null;
  onHighlightChange?: (key: string | null) => void;
}

function DonutTooltipPeriodRow({
  color,
  label,
  locale,
  value,
  valueLabel,
  share,
}: {
  color: string;
  label: string;
  locale: Locale;
  value: number;
  valueLabel: string;
  share: number;
}) {
  return (
    <div className="flex w-full items-center gap-3">
      <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-none"
          style={{ backgroundColor: color }}
        />
        <span className="truncate text-muted-foreground">{label}</span>
      </span>
      <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
        {numberFormat(locale, value)} {valueLabel} ·{" "}
        {share < 0.1 ? "\u00a0" : ""}
        {percentFormatWithOneDecimal(locale, share)}
      </span>
    </div>
  );
}

export const DonutChart = memo(function DonutChart({
  data,
  comparisonData,
  currentLabel,
  comparisonLabel,
  locale,
  valueLabel,
  innerRadius = 54,
  outerRadius = 90,
  className,
  highlightedKey,
  onHighlightChange,
}: DonutChartProps) {
  const chartData = useMemo(() => Array.from(data), [data]);
  const comparisonChartData = useMemo(
    () => (comparisonData == null ? undefined : Array.from(comparisonData)),
    [comparisonData],
  );
  const [internalHighlightedKey, setInternalHighlightedKey] = useState<
    string | null
  >(null);
  const activeHighlightedKey =
    highlightedKey === undefined ? internalHighlightedKey : highlightedKey;
  const handleHighlightChange = useCallback(
    (key: string | null) => {
      if (highlightedKey === undefined) setInternalHighlightedKey(key);
      onHighlightChange?.(key);
    },
    [highlightedKey, onHighlightChange],
  );
  const currentByKey = useMemo(
    () => new Map(chartData.map((item) => [item.key, item])),
    [chartData],
  );
  const comparisonByKey = useMemo(
    () => new Map((comparisonChartData ?? []).map((item) => [item.key, item])),
    [comparisonChartData],
  );
  const chartConfig = useMemo(
    () =>
      chartData.reduce((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.color,
        };
        return config;
      }, {} as ChartConfig),
    [chartData],
  );
  const ringGeometry = useMemo(() => {
    if (!comparisonChartData) return null;

    const requestedOuterRadius =
      typeof outerRadius === "number" ? outerRadius : 90;
    const requestedInnerRadius =
      typeof innerRadius === "number" ? innerRadius : 54;
    const originalThickness = Math.max(
      8,
      requestedOuterRadius - requestedInnerRadius,
    );
    const ringThickness = Math.max(
      8,
      Math.min(12, Math.round(originalThickness * 0.45)),
    );
    const ringGap = Math.max(3, Math.min(5, Math.round(ringThickness * 0.4)));
    const comparisonOuterRadius = requestedOuterRadius;
    const comparisonInnerRadius = comparisonOuterRadius - ringThickness;
    const currentOuterRadius = comparisonInnerRadius - ringGap;
    const currentInnerRadius = Math.max(0, currentOuterRadius - ringThickness);

    return {
      comparisonInnerRadius,
      comparisonOuterRadius,
      currentInnerRadius,
      currentOuterRadius,
    };
  }, [comparisonChartData, innerRadius, outerRadius]);
  const segmentOpacity = useCallback(
    (key: string) =>
      activeHighlightedKey === null || activeHighlightedKey === key ? 1 : 0.28,
    [activeHighlightedKey],
  );

  return (
    <div className={cn("relative aspect-square w-full", className)}>
      <ChartContainer
        className="h-full w-full aspect-auto [&_.recharts-tooltip-wrapper]:z-20"
        config={chartConfig}
      >
        <PieChart accessibilityLayer>
          <ChartTooltip
            cursor={false}
            content={({ active, payload }) => {
              const payloadItem = payload?.[0]?.payload as
                DonutChartDataPoint | undefined;
              const itemKey = activeHighlightedKey ?? payloadItem?.key;
              const currentItem = itemKey
                ? currentByKey.get(itemKey)
                : undefined;
              const comparisonItem = itemKey
                ? comparisonByKey.get(itemKey)
                : undefined;
              const item = currentItem ?? comparisonItem ?? payloadItem;
              if (!active || !item) return null;

              if (comparisonChartData) {
                return (
                  <div className="grid min-w-[16rem] gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <span className="truncate text-muted-foreground">
                      {item.label}
                    </span>
                    <div className="grid gap-1">
                      <DonutTooltipPeriodRow
                        color={currentItem?.color ?? "var(--color-chart-1)"}
                        label={currentLabel ?? ""}
                        locale={locale}
                        value={currentItem?.value ?? 0}
                        valueLabel={valueLabel}
                        share={currentItem?.share ?? 0}
                      />
                      <DonutTooltipPeriodRow
                        color={
                          comparisonItem?.color ??
                          "var(--color-compare-chart-1)"
                        }
                        label={comparisonLabel ?? ""}
                        locale={locale}
                        value={comparisonItem?.value ?? 0}
                        valueLabel={valueLabel}
                        share={comparisonItem?.share ?? 0}
                      />
                    </div>
                  </div>
                );
              }

              return (
                <div className="grid min-w-[16rem] gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <div className="flex w-full items-center gap-3">
                    <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-none"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="truncate text-muted-foreground">
                        {item.label}
                      </span>
                    </span>
                    <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                      {numberFormat(locale, item.value)} {valueLabel} ·{" "}
                      {item.share < 0.1 ? "\u00a0" : ""}
                      {percentFormatWithOneDecimal(locale, item.share)}
                    </span>
                  </div>
                </div>
              );
            }}
          />
          {ringGeometry ? (
            <Pie
              data={comparisonChartData}
              dataKey="value"
              nameKey="label"
              innerRadius={ringGeometry.comparisonInnerRadius}
              outerRadius={ringGeometry.comparisonOuterRadius}
              paddingAngle={2}
              stroke="var(--background)"
              strokeWidth={1}
              startAngle={90}
              endAngle={-270}
              onMouseEnter={(_, index) =>
                handleHighlightChange(comparisonChartData?.[index]?.key ?? null)
              }
              onMouseLeave={() => handleHighlightChange(null)}
            >
              {comparisonChartData?.map((item) => (
                <Cell
                  key={"comparison-" + item.key}
                  fill={item.color}
                  opacity={segmentOpacity(item.key)}
                />
              ))}
            </Pie>
          ) : null}
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius={ringGeometry?.currentInnerRadius ?? innerRadius}
            outerRadius={ringGeometry?.currentOuterRadius ?? outerRadius}
            paddingAngle={2}
            stroke="var(--background)"
            strokeWidth={1}
            startAngle={90}
            endAngle={-270}
            onMouseEnter={(_, index) =>
              handleHighlightChange(chartData[index]?.key ?? null)
            }
            onMouseLeave={() => handleHighlightChange(null)}
          >
            {chartData.map((item) => (
              <Cell
                key={item.key}
                fill={item.color}
                opacity={segmentOpacity(item.key)}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    </div>
  );
});
