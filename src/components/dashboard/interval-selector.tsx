"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Interval = "hour" | "day";

interface IntervalSelectorProps {
  value: Interval;
  onChange: (value: Interval) => void;
  labels?: { hour?: string; day?: string };
}

export function IntervalSelector({ value, onChange, labels }: IntervalSelectorProps) {
  return (
    <div className="flex rounded-md border bg-def-100 p-0.5">
      {(["hour", "day"] as const).map((key) => (
        <Button
          key={key}
          variant="ghost"
          size="sm"
          className={cn(
            "h-6 rounded-[3px] px-2.5 text-xs font-medium",
            value === key
              ? "bg-def-200 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onChange(key)}
        >
          {labels?.[key] ?? (key === "hour" ? "Hourly" : "Daily")}
        </Button>
      ))}
    </div>
  );
}
