"use client";

import { PercentageBar } from "@/components/widget/percentage-bar";

interface PagesTableProps {
  data: Array<{ pathname: string; views: number; sessions: number }>;
  sortBy?: "views" | "sessions";
}

export function PagesBarChart({ data, sortBy = "views" }: PagesTableProps) {
  const sorted = [...data].sort((a, b) => b[sortBy] - a[sortBy]);
  const max = sorted.length > 0 ? sorted[0][sortBy] : 0;

  if (sorted.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No data</p>;
  }

  return (
    <div className="divide-y divide-border">
      {sorted.map((item) => (
        <PercentageBar
          key={item.pathname}
          label={item.pathname}
          value={item[sortBy]}
          max={max}
        />
      ))}
    </div>
  );
}
