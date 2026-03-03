"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

interface SessionDurationChartProps {
  durationsMs: number[];
}

const config = {
  count: {
    label: "Count",
    color: "var(--color-chart-2)",
  },
} satisfies ChartConfig;

function bucketLabel(index: number): string {
  if (index === 0) return "<10s";
  if (index === 1) return "10-30s";
  if (index === 2) return "30-60s";
  if (index === 3) return "1-3m";
  return "3m+";
}

function toBucketIndex(ms: number): number {
  if (ms < 10_000) return 0;
  if (ms < 30_000) return 1;
  if (ms < 60_000) return 2;
  if (ms < 180_000) return 3;
  return 4;
}

export function SessionDurationChart({ durationsMs }: SessionDurationChartProps) {
  const bucketCounts = [0, 0, 0, 0, 0];
  for (const value of durationsMs) {
    const index = toBucketIndex(value);
    bucketCounts[index] += 1;
  }

  const chartData = bucketCounts.map((count, index) => ({
    range: bucketLabel(index),
    count,
  }));

  if (durationsMs.length === 0) {
    return null;
  }

  return (
    <ChartContainer className="h-[240px] w-full aspect-auto" config={config}>
      <BarChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="range" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
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
        <Bar dataKey="count" fill="var(--color-count)" radius={0} />
      </BarChart>
    </ChartContainer>
  );
}
