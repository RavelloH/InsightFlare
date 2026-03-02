"use client";

import { PercentageBar } from "@/components/widget/percentage-bar";

interface BreakdownItem {
  id: string;
  label: string;
  value: number;
  sublabel?: string;
}

interface BreakdownListProps {
  items: BreakdownItem[];
  emptyLabel?: string;
}

export function BreakdownList({ items, emptyLabel = "No data" }: BreakdownListProps) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const max = items.reduce((acc, item) => Math.max(acc, item.value), 0);

  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <PercentageBar
          key={item.id}
          label={item.label}
          value={item.value}
          max={max}
          sublabel={item.sublabel}
        />
      ))}
    </div>
  );
}

