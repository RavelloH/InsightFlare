import { type ComponentType, memo, useMemo, useState } from "react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface ShareBarChartItem {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
  isOther?: boolean;
  icon?: ComponentType<{ className?: string }>;
}

export type ShareBarChartMaxItems = 2 | 3 | 4 | 5 | 6;

export interface ShareBarChartProps {
  items: ReadonlyArray<ShareBarChartItem>;
  comparisonItems?: ReadonlyArray<ShareBarChartItem>;
  comparisonLabel?: string;
  maxItems: ShareBarChartMaxItems;
  locale: Locale;
  valueLabel: string;
  ariaLabel?: string;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
}

const SHARE_BAR_LEGEND_GRID_CLASS: Record<ShareBarChartMaxItems, string> = {
  2: "grid-cols-2 h-4 content-start",
  3: "grid-cols-3 h-4 content-start",
  4: "grid-cols-2 h-10 content-start",
  5: "grid-cols-3 h-10 content-start",
  6: "grid-cols-3 h-10 content-start",
};

function ShareBarChartContentSkeleton({
  maxItems,
  className,
}: {
  maxItems: ShareBarChartMaxItems;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-4", className)}>
      <Skeleton className="h-6 w-full" />
      <div
        className={cn(
          "grid gap-x-6 gap-y-2",
          SHARE_BAR_LEGEND_GRID_CLASS[maxItems],
        )}
      >
        {Array.from({ length: maxItems }, (_, index) => (
          <div
            key={`share-bar-chart-content-skeleton-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="size-2.5 shrink-0" />
              <Skeleton className="h-4 w-[min(12rem,55%)]" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ShareBarChartSkeleton({
  maxItems,
  className,
}: {
  maxItems: ShareBarChartMaxItems;
  className?: string;
}) {
  return (
    <ShareBarChartContentSkeleton maxItems={maxItems} className={className} />
  );
}

interface ShareBarChartContentProps {
  items: ReadonlyArray<ShareBarChartItem>;
  maxItems: ShareBarChartMaxItems;
  locale: Locale;
  valueLabel: string;
  ariaLabel?: string;
  emptyLabel?: string;
  groupKey: "current" | "comparison";
  periodLabel?: string;
  hoveredKey: string | null;
  onHoveredKeyChange: (key: string | null) => void;
}

function ShareBarChartContent({
  items,
  maxItems,
  locale,
  valueLabel,
  ariaLabel,
  emptyLabel,
  groupKey,
  periodLabel,
  hoveredKey,
  onHoveredKeyChange,
}: ShareBarChartContentProps) {
  if (items.length === 0) {
    return (
      <div
        className="flex min-h-[96px] items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div
        className="flex h-6 w-full overflow-hidden rounded-none bg-muted ring-1 ring-border/50"
        role="group"
        aria-label={ariaLabel}
      >
        {items.map((item) => {
          const width = `${Math.min(100, Math.max(0, item.share * 100)).toFixed(2)}%`;
          const itemHoverKey = `${groupKey}:${item.key}`;
          const titleText = `${periodLabel ? `${periodLabel} · ` : ""}${item.label}: ${numberFormat(locale, item.value)} ${valueLabel}, ${percentFormat(locale, item.share)}`;
          const isHovered = hoveredKey === itemHoverKey;
          const hasHoveredItem = hoveredKey !== null;

          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={titleText}
                  className={cn(
                    "h-full min-w-0 shrink-0 border-r border-background/80 bg-transparent p-0 transition-[filter] duration-150 last:border-r-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    hasHoveredItem && !isHovered && "brightness-50 saturate-50",
                    isHovered && "brightness-110 saturate-125",
                    item.share <= 0 && "hidden",
                  )}
                  style={{
                    width,
                    backgroundColor: item.color,
                  }}
                  onPointerEnter={() => onHoveredKeyChange(itemHoverKey)}
                  onPointerLeave={() => onHoveredKeyChange(null)}
                  onFocus={() => onHoveredKeyChange(itemHoverKey)}
                  onBlur={() => onHoveredKeyChange(null)}
                />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                <div className="grid gap-0.5">
                  <span>
                    {periodLabel ? `${periodLabel} · ` : ""}
                    {item.label}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-background/70">
                    {numberFormat(locale, item.value)} {valueLabel} ·{" "}
                    {percentFormat(locale, item.share)}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div
        className={cn(
          "grid gap-x-6 gap-y-2",
          SHARE_BAR_LEGEND_GRID_CLASS[maxItems],
        )}
      >
        {items.map((item) => {
          const ItemIcon = item.icon;

          return (
            <div
              key={item.key}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-none"
                  style={{ backgroundColor: item.color }}
                />
                {ItemIcon ? (
                  <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : null}
                <span className="truncate text-xs text-muted-foreground">
                  {item.label}
                </span>
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {numberFormat(locale, item.value)}
                </span>
                <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                  {percentFormat(locale, item.share)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ShareBarChart = memo(function ShareBarChart({
  items,
  comparisonItems,
  comparisonLabel,
  maxItems,
  locale,
  valueLabel,
  ariaLabel,
  loading = false,
  emptyLabel,
  className,
}: ShareBarChartProps) {
  const resolvedAriaLabel = useMemo(
    () =>
      ariaLabel ??
      items
        .map(
          (item) =>
            `${item.label} ${percentFormat(locale, item.share)} (${numberFormat(locale, item.value)} ${valueLabel})`,
        )
        .join(", "),
    [ariaLabel, items, locale, valueLabel],
  );
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const currentTransitionKey = loading
    ? "loading"
    : items.length === 0
      ? "empty"
      : "content";
  const comparisonTransitionKey = comparisonItems
    ? comparisonItems.length === 0
      ? "empty"
      : "content"
    : "hidden";
  const resolvedComparisonAriaLabel = comparisonItems
    ? `${comparisonLabel ? `${comparisonLabel}: ` : ""}${comparisonItems
        .map(
          (item) =>
            `${item.label} ${percentFormat(locale, item.share)} (${numberFormat(locale, item.value)} ${valueLabel})`,
        )
        .join(", ")}`
    : undefined;

  return (
    <div className={cn("grid gap-4", className)}>
      <AutoResizer className="min-w-0">
        <AutoTransition
          initial={false}
          transitionKey={currentTransitionKey}
          duration={0.2}
          type="crossFade"
        >
          {loading ? (
            <ShareBarChartContentSkeleton key="loading" maxItems={maxItems} />
          ) : (
            <ShareBarChartContent
              key={currentTransitionKey}
              items={items}
              maxItems={maxItems}
              locale={locale}
              valueLabel={valueLabel}
              ariaLabel={resolvedAriaLabel}
              emptyLabel={emptyLabel}
              groupKey="current"
              hoveredKey={hoveredKey}
              onHoveredKeyChange={setHoveredKey}
            />
          )}
        </AutoTransition>
      </AutoResizer>

      <AutoResizer className="min-w-0">
        <AutoTransition
          initial={false}
          transitionKey={comparisonTransitionKey}
          duration={0.2}
          type="crossFade"
        >
          {comparisonItems ? (
            <ShareBarChartContent
              key={`comparison-${comparisonTransitionKey}`}
              items={comparisonItems}
              maxItems={maxItems}
              locale={locale}
              valueLabel={valueLabel}
              ariaLabel={resolvedComparisonAriaLabel}
              emptyLabel={emptyLabel}
              groupKey="comparison"
              periodLabel={comparisonLabel}
              hoveredKey={hoveredKey}
              onHoveredKeyChange={setHoveredKey}
            />
          ) : null}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
});
