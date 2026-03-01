"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPoint } from "@/lib/edge-client";
import { compactNumber } from "@/lib/utils";

interface TrendChartProps {
  data: TrendPoint[];
}

function formatTick(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function TrendChart({ data }: TrendChartProps): React.JSX.Element {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="viewsStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b3b9d" stopOpacity={1} />
              <stop offset="100%" stopColor="#0b3b9d" stopOpacity={0.25} />
            </linearGradient>
            <linearGradient id="sessionsStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#d6490f" stopOpacity={1} />
              <stop offset="100%" stopColor="#d6490f" stopOpacity={0.25} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 4" stroke="#dbe5ff" />
          <XAxis
            dataKey="timestampMs"
            stroke="#5b6f9f"
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTick}
            minTickGap={28}
          />
          <YAxis stroke="#5b6f9f" tickLine={false} axisLine={false} tickFormatter={(v) => compactNumber(Number(v))} />
          <Tooltip
            contentStyle={{
              borderRadius: "12px",
              border: "1px solid #d2dcf3",
              background: "rgba(255,255,255,0.95)",
              backdropFilter: "blur(6px)",
            }}
            formatter={(value) => compactNumber(Number(value))}
            labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
          />
          <Line type="monotone" dataKey="views" stroke="url(#viewsStroke)" strokeWidth={3} dot={false} />
          <Line type="monotone" dataKey="sessions" stroke="url(#sessionsStroke)" strokeWidth={2.25} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

