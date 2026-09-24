import { memo, type ReactNode } from "react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export const PerformanceDynamicValue = memo(function PerformanceDynamicValue({
  children,
  loading,
  skeletonClassName,
  className,
  transitionKey,
}: {
  children: ReactNode;
  loading: boolean;
  skeletonClassName: string;
  className?: string;
  transitionKey?: string | number;
}) {
  return (
    <AutoResizer className={cn("min-w-0", className)} duration={0.2}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : (transitionKey ?? "ready")}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="flex min-h-5 min-w-0 items-center"
      >
        {loading ? (
          <Skeleton key="loading" className={skeletonClassName} />
        ) : (
          <div key="ready" className="min-h-5 min-w-0">
            {children}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});

export const PerformancePanelText = memo(function PerformancePanelText({
  children,
  transitionKey,
  className,
  resizerClassName,
  animateWidth = false,
}: {
  children: ReactNode;
  transitionKey: string | number;
  className?: string;
  resizerClassName?: string;
  animateWidth?: boolean;
}) {
  return (
    <AutoResizer
      className={cn("min-w-0", resizerClassName)}
      duration={0.2}
      animateWidth={animateWidth}
      animateHeight={!animateWidth}
    >
      <AutoTransition
        className={cn("min-w-0", className)}
        initial={false}
        transitionKey={transitionKey}
        duration={0.18}
        type="fade"
        presenceMode="wait"
      >
        {children}
      </AutoTransition>
    </AutoResizer>
  );
});

export const PerformanceSpinnerValue = memo(function PerformanceSpinnerValue({
  children,
  loading,
  transitionKey,
}: {
  children: ReactNode;
  loading: boolean;
  transitionKey?: string | number;
}) {
  return (
    <AutoResizer initial animateHeight={false} className="mt-2 h-7">
      <AutoTransition
        className="h-7"
        transitionKey={loading ? "loading" : (transitionKey ?? "ready")}
        initial={false}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <div key="loading" className="flex h-7 items-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div key="ready" className="h-7 min-w-0">
            {children}
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
});
