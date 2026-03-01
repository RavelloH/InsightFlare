"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedCounter } from "@/components/shared/animated-counter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: number;
  formatter?: (value: number) => string;
  hint?: string;
  loading?: boolean;
}

export function MetricCard({ label, value, formatter, hint, loading }: MetricCardProps) {
  if (loading) {
    return (
      <div className="shadow-[0_0_0_0.5px] shadow-border p-4 min-h-[88px] flex flex-col justify-center gap-2">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  return (
    <div className="shadow-[0_0_0_0.5px] shadow-border p-4 min-h-[88px] flex flex-col justify-center gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-muted-foreground leading-[1.1]">
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
      <div className="font-mono text-3xl font-bold leading-[1.1]">
        <AnimatedCounter value={value} formatter={formatter} />
      </div>
    </div>
  );
}
