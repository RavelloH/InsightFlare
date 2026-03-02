"use client";

import { cn } from "@/lib/utils";

interface PercentageBarProps {
  value: number;
  max: number;
  label: string;
  sublabel?: string;
  className?: string;
}

export function PercentageBar({ value, max, label, sublabel, className }: PercentageBarProps) {
  const percent = max > 0 ? (value / max) * 100 : 0;

  return (
    <div className={cn("relative flex items-center px-4 py-2.5 min-h-[40px]", className)}>
      <div
        className="absolute inset-y-0 left-0 bg-chart-1/10 rounded-r transition-all duration-300"
        style={{ width: `${Math.max(percent, 0.5)}%` }}
      />
      <div className="relative flex w-full items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm">{label}</span>
          {sublabel && (
            <span className="shrink-0 text-xs text-muted-foreground">{sublabel}</span>
          )}
        </div>
        <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
          {value.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
