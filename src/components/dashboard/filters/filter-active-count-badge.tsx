import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { cn } from "@/lib/utils";

export function FilterActiveCountBadge({
  className,
  count,
}: {
  className?: string;
  count: number;
}) {
  const hasCount = count > 0;

  return (
    <AutoResizer
      initial
      animateWidth
      animateHeight={false}
      className={cn(
        "inline-flex shrink-0 items-center",
        !hasCount && "-mr-2",
        className,
      )}
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
            key={`active-filter-count-${count}`}
            className="inline-flex min-w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 px-1.5 text-[11px] leading-4 font-semibold text-primary"
          >
            {count}
          </span>
        ) : (
          <span
            key="active-filter-count-empty"
            className="inline-flex w-0 overflow-hidden"
            aria-hidden
          />
        )}
      </AutoTransition>
    </AutoResizer>
  );
}
