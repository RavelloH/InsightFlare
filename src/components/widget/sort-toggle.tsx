"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type SortKey = "views" | "sessions";

interface SortToggleProps {
  value: SortKey;
  onChange: (value: SortKey) => void;
  labels?: { views?: string; sessions?: string };
}

export function SortToggle({ value, onChange, labels }: SortToggleProps) {
  return (
    <div className="flex rounded-md border bg-def-100 p-0.5">
      {(["views", "sessions"] as const).map((key) => (
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
          {labels?.[key] ?? (key === "views" ? "Views" : "Sessions")}
        </Button>
      ))}
    </div>
  );
}
