import { memo, useMemo } from "react";
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
  locale: Locale;
  valueLabel: string;
  innerRadius?: number | string;
  outerRadius?: number | string;
  className?: string;
}

export const DonutChart = memo(function DonutChart({
  data,
  locale,
  valueLabel,
  innerRadius = 54,
  outerRadius = 90,
  className,
}: DonutChartProps) {
  const chartData = useMemo(() => Array.from(data), [data]);
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
              const item = payload?.[0]?.payload as
                DonutChartDataPoint | undefined;
              if (!active || !item) return null;

              return (
                <div className="grid min-w-[16rem] gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <div className="flex w-full items-center gap-3">
                    <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-none"
                        style={{ backgroundColor: item.color }}
                      />
                      <span
                        className="truncate text-muted-foreground"
                        title={item.label}
                      >
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
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={2}
            stroke="var(--background)"
            strokeWidth={1}
            startAngle={90}
            endAngle={-270}
          >
            {chartData.map((item) => (
              <Cell key={item.key} fill={item.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    </div>
  );
});
