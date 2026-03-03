"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

interface TopItemsChartProps {
  items: Array<{
    label: string;
    value: number;
  }>;
  valueLabel: string;
}

const config = {
  value: {
    label: "Value",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

export function TopItemsChart({ items, valueLabel }: TopItemsChartProps) {
  const chartData = items.slice(0, 8).map((item) => ({
    ...item,
    shortLabel: item.label.length > 24 ? `${item.label.slice(0, 24)}...` : item.label,
  }));

  return (
    <ChartContainer className="h-[280px] w-full" config={config}>
      <BarChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="shortLabel"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={8}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => {
                const numeric = typeof value === "number" ? value : Number(value ?? 0);
                return (
                  <div className="flex min-w-28 items-center justify-between gap-4">
                    <span>{valueLabel}</span>
                    <span className="font-mono">{numeric.toLocaleString()}</span>
                  </div>
                );
              }}
            />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={0} />
      </BarChart>
    </ChartContainer>
  );
}
