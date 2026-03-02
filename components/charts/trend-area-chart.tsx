"use client";

import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { TrendPoint } from "@/lib/edge-client";
import { compactNumber } from "@/lib/utils";

type MetricKey = "views" | "sessions";

interface TrendAreaChartProps {
  data: TrendPoint[];
  activeMetric?: MetricKey;
  interval?: "hour" | "day";
}

const chartConfig = {
  views: {
    label: "Views",
    color: "hsl(var(--chart-1))",
  },
  sessions: {
    label: "Sessions",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig;

function formatTick(timestampMs: number, interval?: "hour" | "day"): string {
  const d = new Date(timestampMs);
  if (interval === "hour") {
    return `${d.getHours()}:00`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function TrendAreaChart({ data, activeMetric, interval }: TrendAreaChartProps) {
  const tickFormatter = useMemo(
    () => (v: number) => formatTick(v, interval),
    [interval]
  );

  const viewsOpacity = !activeMetric || activeMetric === "views" ? 1 : 0.2;
  const sessionsOpacity = !activeMetric || activeMetric === "sessions" ? 1 : 0.2;

  return (
    <ChartContainer config={chartConfig} className="h-[280px] w-full">
      <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-views)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-views)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="sessionsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-sessions)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-sessions)" stopOpacity={0} />
          </linearGradient>
          <filter id="line-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComponentTransfer in="blur" result="dimmedBlur">
              <feFuncA type="linear" slope="0.4" />
            </feComponentTransfer>
            <feComposite in="SourceGraphic" in2="dimmedBlur" operator="over" />
          </filter>
        </defs>
        <CartesianGrid vertical={false} className="stroke-border" />
        <XAxis
          dataKey="timestampMs"
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
          minTickGap={28}
          fontSize={12}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => compactNumber(Number(v))}
          fontSize={12}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (payload?.[0]?.payload?.timestampMs) {
                  return new Date(payload[0].payload.timestampMs).toLocaleString();
                }
                return "";
              }}
              formatter={(value, name) => (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{chartConfig[name as MetricKey]?.label ?? name}</span>
                  <span className="font-mono font-medium tabular-nums">{compactNumber(Number(value))}</span>
                </div>
              )}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="views"
          stroke="var(--color-views)"
          fill="url(#viewsFill)"
          strokeWidth={activeMetric === "views" ? 2.5 : 2}
          strokeOpacity={viewsOpacity}
          fillOpacity={viewsOpacity * 0.8}
          dot={false}
          filter="url(#line-glow)"
        />
        <Area
          type="monotone"
          dataKey="sessions"
          stroke="var(--color-sessions)"
          fill="url(#sessionsFill)"
          strokeWidth={activeMetric === "sessions" ? 2.5 : 2}
          strokeOpacity={sessionsOpacity}
          fillOpacity={sessionsOpacity * 0.8}
          dot={false}
          filter="url(#line-glow)"
        />
      </AreaChart>
    </ChartContainer>
  );
}
