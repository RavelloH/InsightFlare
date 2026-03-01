"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "@/lib/edge-client";
import { compactNumber } from "@/lib/utils";

interface TrendAreaChartProps {
  data: TrendPoint[];
}

function formatTick(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function TrendAreaChart({ data }: TrendAreaChartProps) {
  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
              <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="sessionsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3} />
              <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
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
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTick}
            minTickGap={28}
            fontSize={12}
          />
          <YAxis
            className="text-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => compactNumber(Number(v))}
            fontSize={12}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--card))",
              color: "hsl(var(--card-foreground))",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              fontSize: "12px",
            }}
            formatter={(value) => compactNumber(Number(value))}
            labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
          />
          <Area
            type="monotone"
            dataKey="views"
            stroke="hsl(var(--chart-1))"
            fill="url(#viewsFill)"
            strokeWidth={2}
            dot={false}
            filter="url(#line-glow)"
          />
          <Area
            type="monotone"
            dataKey="sessions"
            stroke="hsl(var(--chart-2))"
            fill="url(#sessionsFill)"
            strokeWidth={2}
            dot={false}
            filter="url(#line-glow)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
