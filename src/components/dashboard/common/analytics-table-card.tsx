import type { CSSProperties, ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface AnalyticsTableCardProps {
  children: ReactNode;
  className?: string;
  /** Documents the intended horizontal layout width for consuming tables. */
  minTableWidth?: string;
}

/** Shared shell for wide, horizontally scrollable analytics tables. */
export function AnalyticsTableCard({
  children,
  className,
  minTableWidth,
}: AnalyticsTableCardProps) {
  return (
    <Card
      className={cn(
        "py-0 [&_[data-slot=table]]:min-w-[var(--analytics-table-min-width)]",
        className,
      )}
      data-analytics-table-card=""
      style={
        minTableWidth
          ? ({ "--analytics-table-min-width": minTableWidth } as CSSProperties)
          : undefined
      }
    >
      <CardContent className="px-0">{children}</CardContent>
    </Card>
  );
}
