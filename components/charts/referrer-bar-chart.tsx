"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compactNumber } from "@/lib/utils";

interface ReferrerBarChartProps {
  data: Array<{ referrer: string; views: number; sessions: number }>;
  directLabel?: string;
}

export function ReferrerBarChart({ data, directLabel = "direct" }: ReferrerBarChartProps) {
  const chartData = data.map((d) => ({
    name: d.referrer || directLabel,
    views: d.views,
  }));

  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 80 }}>
          <CartesianGrid horizontal={false} className="stroke-border" />
          <XAxis type="number" tickFormatter={(v) => compactNumber(Number(v))} fontSize={11} className="text-muted-foreground" />
          <YAxis type="category" dataKey="name" width={80} fontSize={11} className="text-muted-foreground" tickLine={false} />
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
          />
          <Bar dataKey="views" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
