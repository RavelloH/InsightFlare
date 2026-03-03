"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { Locale } from "@/lib/i18n/config";
import { intlLocale } from "@/lib/dashboard/format";

interface EngagementChartProps {
  locale: Locale;
  data: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }>;
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
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

export function EngagementChart({ locale, data, viewsLabel, sessionsLabel }: EngagementChartProps) {
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
  });

  const chartData = data.map((point) => ({
    ...point,
    label: formatter.format(new Date(point.timestampMs)),
  }));

  if (chartData.length === 0) {
    return null;
  }

  return (
    <ChartContainer className="h-[240px] w-full aspect-auto" config={config}>
      <AreaChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={10} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip
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
        <Area
          type="monotone"
          dataKey="views"
          stroke="var(--color-views)"
          fill="var(--color-views)"
          fillOpacity={0.22}
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="sessions"
          stroke="var(--color-sessions)"
          fill="var(--color-sessions)"
          fillOpacity={0.16}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
