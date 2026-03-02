"use client";

import { PercentageBar } from "@/components/widget/percentage-bar";

interface ReferrersTableProps {
  data: Array<{ referrer: string; views: number; sessions: number }>;
  sortBy?: "views" | "sessions";
  directLabel?: string;
}

export function ReferrerBarChart({ data, sortBy = "views", directLabel = "direct" }: ReferrersTableProps) {
  const sorted = [...data].sort((a, b) => b[sortBy] - a[sortBy]);
  const max = sorted.length > 0 ? sorted[0][sortBy] : 0;

  if (sorted.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">No data</p>;
  }

  return (
    <div className="divide-y divide-border">
      {sorted.map((item) => (
        <PercentageBar
          key={item.referrer || "__direct__"}
          label={item.referrer || directLabel}
          value={item[sortBy]}
          max={max}
        />
      ))}
    </div>
  );
}
