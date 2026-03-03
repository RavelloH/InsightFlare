"use client";

import { Pie, PieChart, Cell } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

interface DistributionDonutChartProps {
  items: Array<{
    label: string;
    value: number;
  }>;
}

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

const config = {
  value: {
    label: "Value",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

export function DistributionDonutChart({ items }: DistributionDonutChartProps) {
  const chartData = items
    .filter((item) => item.value > 0)
    .slice(0, 8)
    .map((item, index) => ({
      ...item,
      fill: COLORS[index % COLORS.length],
    }));

  if (chartData.length === 0) {
    return null;
  }

  return (
    <div>
      <ChartContainer className="h-[240px] w-full aspect-auto" config={config}>
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => {
                  const numeric = typeof value === "number" ? value : Number(value ?? 0);
                  return (
                    <div className="flex min-w-28 items-center justify-between gap-4">
                      <span>{String(name)}</span>
                      <span className="font-mono">{numeric.toLocaleString()}</span>
                    </div>
                  );
                }}
              />
            }
          />
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius={52}
            outerRadius={86}
            paddingAngle={2}
            strokeWidth={0}
          >
            {chartData.map((entry, index) => (
              <Cell key={`${entry.label}-${index}`} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {chartData.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-2 rounded-none border px-2 py-1">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="size-2.5 shrink-0" style={{ backgroundColor: item.fill }} />
              <span className="truncate text-xs">{item.label}</span>
            </div>
            <span className="font-mono text-xs">{item.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
