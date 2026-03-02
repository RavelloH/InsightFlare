"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedCounter } from "@/components/shared/animated-counter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RiInformationLine as Info } from "@remixicon/react";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: number;
  formatter?: (value: number) => string;
  hint?: string;
  loading?: boolean;
  active?: boolean;
  onClick?: () => void;
  metricKey?: string;
}

const metricColors: Record<string, string> = {
  views: "bg-chart-1",
  sessions: "bg-chart-2",
  visitors: "bg-chart-3",
  bounceRate: "bg-chart-4",
  avgDuration: "bg-chart-5",
};

export function MetricCard({ label, value, formatter, hint, loading, active, onClick, metricKey }: MetricCardProps) {
  if (loading) {
    return (
      <div className="shadow-[0_0_0_0.5px] shadow-border p-4 min-h-[88px] flex flex-col justify-center gap-2">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

    return (
      <div
        className={cn(
        "relative shadow-[0_0_0_0.5px] shadow-border p-4 min-h-[88px] flex flex-col justify-center gap-1 transition-colors",
        onClick && "cursor-pointer hover:bg-def-100",
        active && "bg-def-100"
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground leading-[1.1]">
          {label}
        </span>
        {hint && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                  <Info className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">{hint}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="font-mono text-2xl font-semibold leading-[1.1]">
        <AnimatedCounter value={value} formatter={formatter} />
      </div>
      {active && metricKey && (
        <div
          className={cn(
            "absolute bottom-0 left-2 right-2 h-0.5 rounded-full",
            metricColors[metricKey] || "bg-chart-1"
          )}
        />
      )}
    </div>
  );
}
