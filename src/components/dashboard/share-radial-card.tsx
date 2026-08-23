import { type ComponentType, useMemo } from "react";
import { RiDonutChartLine } from "@remixicon/react";

import {
  ShareBarChart,
  type ShareBarChartItem,
  type ShareBarChartMaxItems,
  ShareBarChartSkeleton,
} from "@/components/dashboard/charts/share-bar-chart";
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
): ResolvedShareItem[] {
  return items.map((item, index) => {
    const value = Math.max(0, Number(item.value ?? 0));

    return {
      ...item,
      value,
      share: totalValue > 0 ? value / totalValue : 0,
      color:
        item.color ??
        (item.isOther
          ? "var(--muted-foreground)"
          : CHART_COLORS[index % CHART_COLORS.length]),
    };
  });
}

export function ShareRadialCard({
  title,
  items,
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

  return (
    <Card className={className}>
      <CardHeader className="gap-2">
        <CardTitle className="inline-flex items-center gap-2">
          <RiDonutChartLine className="size-4" />
          {title}
        </CardTitle>
        <AutoTransition
          className="h-7"
          initial={false}
          transitionKey={loading ? "loading" : "ready"}
          duration={0.2}
          type="crossFade"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-baseline gap-2">
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-4 w-14" />
            </div>
          ) : (
            <div key="ready" className="flex h-7 items-baseline gap-2">
              <span className="font-mono text-xl font-medium tabular-nums text-foreground">
                {numberFormat(locale, totalValue)}
              </span>
              <span className="text-xs text-muted-foreground">
                {valueLabel}
              </span>
            </div>
          )}
        </AutoTransition>
      </CardHeader>
      <CardContent>
        <ShareBarChart
          ariaLabel={ariaLabel}
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
}

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
