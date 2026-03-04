"use client";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { Locale } from "@/lib/i18n/config";
import { intlLocale } from "@/lib/dashboard/format";

interface TrendChartPoint {
  timestampMs: number;
  views: number;
  sessions: number;
}

interface TrendChartProps {
  locale: Locale;
  data: TrendChartPoint[];
  viewsLabel: string;
  sessionsLabel: string;
}

const config = {
  views: {
    label: "Views",
    color: "var(--color-chart-1)",
  },
  sessions: {
    label: "Sessions",
    color: "var(--color-chart-2)",
  },
} satisfies ChartConfig;

export function TrendChart({ locale, data, viewsLabel, sessionsLabel }: TrendChartProps) {
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
  });

  const chartData = data.map((point) => ({
    ...point,
    label: formatter.format(new Date(point.timestampMs)),
  }));

  return (
    <ChartContainer className="h-[280px] w-full" config={config}>
      <LineChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={12}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
        <ChartTooltip
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 20 }}
          content={
            <ChartTooltipContent
              formatter={(value, name) => {
                const label = name === "views" ? viewsLabel : sessionsLabel;
                const numeric = typeof value === "number" ? value : Number(value ?? 0);
                return (
                  <div className="flex min-w-28 items-center justify-between gap-4">
                    <span>{label}</span>
                    <span className="font-mono">{numeric.toLocaleString()}</span>
                  </div>
                );
              }}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="views"
          stroke="var(--color-views)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="sessions"
          stroke="var(--color-sessions)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
