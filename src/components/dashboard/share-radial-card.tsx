import { type ComponentType, memo, useMemo } from "react";
import { RiDonutChartLine } from "@remixicon/react";

import {
  ShareBarChart,
  type ShareBarChartItem,
  type ShareBarChartMaxItems,
  ShareBarChartSkeleton,
} from "@/components/dashboard/charts/share-bar-chart";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;
const COMPARISON_CHART_COLORS = [
  "var(--color-compare-chart-1)",
  "var(--color-compare-chart-2)",
  "var(--color-compare-chart-3)",
  "var(--color-compare-chart-4)",
  "var(--color-compare-chart-5)",
] as const;

export interface ShareRadialCardItem {
  key: string;
  label: string;
  value: number;
  isOther?: boolean;
  color?: string;
  icon?: ComponentType<{ className?: string }>;
}

interface ShareRadialCardProps {
  title: string;
  items: ShareRadialCardItem[];
  comparisonItems?: ShareRadialCardItem[];
  comparisonLabel?: string;
  maxItems: ShareBarChartMaxItems;
  locale: Locale;
  valueLabel: string;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
}

type ResolvedShareItem = ShareBarChartItem;

function resolveShareItems(
  items: ShareRadialCardItem[],
  totalValue: number,
  comparison = false,
): ResolvedShareItem[] {
  return items.map((item, index) => {
    const value = Math.max(0, Number(item.value ?? 0));

    return {
      ...item,
      value,
      share: totalValue > 0 ? value / totalValue : 0,
      color: comparison
        ? item.isOther
          ? "var(--muted-foreground)"
          : COMPARISON_CHART_COLORS[index % COMPARISON_CHART_COLORS.length]
        : (item.color ??
          (item.isOther
            ? "var(--muted-foreground)"
            : CHART_COLORS[index % CHART_COLORS.length])),
    };
  });
}

export const ShareRadialCard = memo(function ShareRadialCard({
  title,
  items,
  comparisonItems,
  comparisonLabel,
  maxItems,
  locale,
  valueLabel,
  loading = false,
  emptyLabel,
  className,
}: ShareRadialCardProps) {
  const totalValue = useMemo(
    () =>
      items.reduce(
        (sum, item) => sum + Math.max(0, Number(item.value ?? 0)),
        0,
      ),
    [items],
  );
  const resolvedItems = useMemo(
    () => resolveShareItems(items, totalValue),
    [items, totalValue],
  );
  const comparisonTotalValue = useMemo(
    () =>
      (comparisonItems ?? []).reduce(
        (sum, item) => sum + Math.max(0, Number(item.value ?? 0)),
        0,
      ),
    [comparisonItems],
  );
  const resolvedComparisonItems = useMemo(
    () =>
      comparisonItems
        ? resolveShareItems(comparisonItems, comparisonTotalValue, true)
        : undefined,
    [comparisonItems, comparisonTotalValue],
  );
  const ariaLabel = useMemo(
    () =>
      `${title}: ${resolvedItems
        .map(
          (item) =>
            `${item.label} ${percentFormat(locale, item.share)} (${numberFormat(locale, item.value)} ${valueLabel})`,
        )
        .join(", ")}`,
    [locale, resolvedItems, title, valueLabel],
  );
  const comparisonHeaderKey = comparisonItems ? "comparison" : "current";

  return (
    <Card className={className}>
      <CardHeader className="gap-2">
        <CardTitle className="inline-flex items-center gap-2">
          <RiDonutChartLine className="size-4" />
          {title}
        </CardTitle>
        <AutoResizer className="w-full" duration={0.2}>
          <AutoTransition
            className="grid min-w-0 grid-cols-2 gap-4"
            initial={false}
            transitionKey={`${loading ? "loading" : "ready"}-${comparisonHeaderKey}`}
            duration={0.2}
            type="crossFade"
          >
            {loading ? (
              <div
                key="loading"
                className="col-span-2 flex h-7 items-baseline gap-2"
              >
                <Skeleton className="h-7 w-20" />
                <Skeleton className="h-4 w-14" />
              </div>
            ) : (
              <>
                <div
                  key="current"
                  className="flex min-w-0 items-baseline gap-2"
                >
                  <span className="font-mono text-xl font-medium tabular-nums text-foreground">
                    {numberFormat(locale, totalValue)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {valueLabel}
                  </span>
                </div>
                {resolvedComparisonItems ? (
                  <div
                    key="comparison"
                    className="flex min-w-0 items-baseline justify-end gap-2"
                  >
                    <span className="truncate text-xs text-muted-foreground">
                      {comparisonLabel}
                    </span>
                    <span className="font-mono text-xl font-medium tabular-nums text-foreground">
                      {numberFormat(locale, comparisonTotalValue)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {valueLabel}
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardHeader>
      <CardContent>
        <ShareBarChart
          ariaLabel={ariaLabel}
          comparisonItems={resolvedComparisonItems}
          comparisonLabel={comparisonLabel}
          emptyLabel={emptyLabel}
          items={resolvedItems}
          loading={loading}
          maxItems={maxItems}
          locale={locale}
          valueLabel={valueLabel}
        />
      </CardContent>
    </Card>
  );
});

export function ShareRadialCardSkeleton({
  className,
  maxItems = 6,
}: {
  className?: string;
  maxItems?: ShareBarChartMaxItems;
}) {
  return (
    <Card className={cn("gap-4", className)}>
      <CardHeader className="gap-2">
        <Skeleton className="h-4 w-36" />
        <div className="flex h-7 items-baseline gap-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-4 w-14" />
        </div>
      </CardHeader>
      <CardContent>
        <ShareBarChartSkeleton maxItems={maxItems} />
      </CardContent>
    </Card>
  );
}
