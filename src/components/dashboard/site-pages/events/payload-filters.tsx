import { RiFilter3Line } from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { type EventPageCopy } from "./types";

function PayloadFilterActiveCountBadge({ count }: { count: number }) {
  const hasCount = count > 0;
  return (
    <AutoResizer
      initial
      animateWidth
      animateHeight={false}
      className="inline-flex shrink-0 items-center"
    >
      <AutoTransition
        className="inline-block"
        duration={0.2}
        type="fade"
        initial={false}
        presenceMode="wait"
        customVariants={{
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          exit: { opacity: 0 },
        }}
      >
        {hasCount ? (
          <span
            key={`payload-filter-count-${count}`}
            className="inline-flex min-w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 px-1.5 text-[11px] leading-4 font-semibold text-primary"
          >
            {count}
          </span>
        ) : (
          <span
            key="payload-filter-count-empty"
            className="inline-flex w-0 overflow-hidden"
            aria-hidden
          />
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

export function PayloadFilterButton({
  labels,
  count,
  onClick,
}: {
  labels: EventPageCopy;
  count: number;
  onClick: () => void;
}) {
  const hasActiveFilters = count > 0;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "gap-2 transition-colors",
        hasActiveFilters &&
          "!border-primary/60 !bg-primary/10 !text-primary hover:!bg-primary/15 hover:!text-primary aria-expanded:!bg-primary/15 dark:!border-primary/60 dark:!bg-primary/20 dark:hover:!bg-primary/25",
      )}
      style={
        hasActiveFilters
          ? {
              borderColor: "hsl(var(--primary) / 0.6)",
              backgroundColor: "hsl(var(--primary) / 0.12)",
              color: "hsl(var(--primary))",
            }
          : undefined
      }
      onClick={onClick}
    >
      <RiFilter3Line className="size-4" />
      {labels.payloadFilter}
      <PayloadFilterActiveCountBadge count={count} />
    </Button>
  );
}
