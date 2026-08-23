import type { ReactNode } from "react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface ContentSwitchProps {
  loading: boolean;
  hasContent: boolean;
  loadingLabel: string;
  loadingContent?: ReactNode;
  emptyContent: ReactNode;
  children: ReactNode;
  className?: string;
  minHeightClassName?: string;
  initial?: boolean;
}

export function ContentSwitch({
  loading,
  hasContent,
  loadingLabel,
  loadingContent,
  emptyContent,
  children,
  className,
  minHeightClassName = "min-h-[120px]",
  initial = true,
}: ContentSwitchProps) {
  return (
    <AutoResizer className={className} initial={initial}>
      <AutoTransition initial={initial} duration={0.22}>
        {loading ? (
          loadingContent ? (
            <div key="loading-content">{loadingContent}</div>
          ) : (
            <div
              key="loading"
              className={cn(
                "flex items-center justify-center gap-2 text-sm text-muted-foreground",
                minHeightClassName,
              )}
            >
              <Spinner className="size-4" />
              <span>{loadingLabel}</span>
            </div>
          )
        ) : hasContent ? (
          <div key="content">{children}</div>
        ) : (
          <div
            key="empty"
            className={cn(
              "flex items-center justify-center text-sm text-muted-foreground",
              minHeightClassName,
            )}
          >
            {emptyContent}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}
