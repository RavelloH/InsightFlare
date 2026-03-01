"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compactNumber } from "@/lib/utils";

interface PagesBarChartProps {
  data: Array<{ pathname: string; views: number }>;
}

export function PagesBarChart({ data }: PagesBarChartProps) {
  const chartData = data.map((d) => ({
    name: d.pathname.length > 30 ? d.pathname.slice(0, 27) + "..." : d.pathname,
    views: d.views,
  }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 80 }}>
          <XAxis type="number" tickFormatter={(v) => compactNumber(Number(v))} fontSize={12} className="text-muted-foreground" />
          <YAxis type="category" dataKey="name" width={80} fontSize={12} className="text-muted-foreground" tickLine={false} />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--card))",
              color: "hsl(var(--card-foreground))",
            }}
            formatter={(value) => compactNumber(Number(value))}
          />
          <Bar dataKey="views" fill="hsl(var(--chart-4))" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
