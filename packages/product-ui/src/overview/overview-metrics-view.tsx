import { memo } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Card, CardContent } from "@insightflare/ui/card";
import { Spinner } from "@insightflare/ui/spinner";
import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import { MetricAreaChart, type MetricAreaPoint } from "../charts";
import type { ChartLocale, DashboardInterval } from "../charts/types";
import { cn } from "../utils/cn";

export const OVERVIEW_METRIC_KEYS = [
  "views",
  "visitors",
  "sessions",
  "bounceRate",
  "pagesPerSession",
  "avgDuration",
] as const;

export type OverviewMetricKey = (typeof OVERVIEW_METRIC_KEYS)[number];
export type OverviewMetricsLabels = Readonly<Record<OverviewMetricKey, string>>;

export interface OverviewMetricsViewItem {
  readonly key: OverviewMetricKey;
  readonly value: string;
  readonly delta: number | null;
  readonly lowerIsBetter?: boolean;
  readonly trend: ReadonlyArray<MetricAreaPoint>;
  readonly comparisonTrend?: ReadonlyArray<MetricAreaPoint>;
  readonly formatTrendValue: (value: number) => string;
}

export interface OverviewMetricsViewProps {
  readonly items: ReadonlyArray<OverviewMetricsViewItem>;
  readonly labels: OverviewMetricsLabels;
  readonly loading: boolean;
  readonly locale: ChartLocale;
  readonly timeZone: string;
  readonly interval: DashboardInterval;
  readonly animationKey: string;
  readonly comparisonLabel?: string;
}

const METRIC_AREA_COLOR = "var(--color-chart-1)";
const COMPARISON_AREA_COLOR = "var(--color-chart-secondary-1)";

function metricCellBorderClasses(index: number): string {
  // Mobile (1-col): top border for all except first
  const mobileHasTop = index >= 1;
  // md (2-col): left border on odd indices, top border for row 2+
  const mdHasLeft = index % 2 !== 0;
  const mdHasTop = index >= 2;
  // lg (3-col): left border on col 2/3, top border for row 2+
  const lgHasLeft = index % 3 !== 0;
  const lgHasTop = index >= 3;

  return cn(
    mobileHasTop ? "border-t" : "",
    // md (2-col): reset mobile top for row 2+, apply left + top
    mdHasTop ? "md:border-t" : "md:border-t-0",
    mdHasLeft ? "md:border-l" : "md:border-l-0",
    // lg (3-col): override md borders
    lgHasTop ? "lg:border-t" : "lg:border-t-0",
    lgHasLeft ? "lg:border-l" : "lg:border-l-0",
  );
}

function changeRateClass(value: number, lowerIsBetter: boolean): string {
  const isImprovement = lowerIsBetter ? value <= 0 : value >= 0;
  return isImprovement ? "text-emerald-600" : "text-rose-600";
}

const ChangeRateInline = memo(function ChangeRateInline({
  value,
  lowerIsBetter = false,
}: {
  value: number | null;
  lowerIsBetter?: boolean;
}) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value, lowerIsBetter)}`}
    >
      <Icon className="size-3.5" />
      {`${value >= 0 ? "+" : ""}${value.toFixed(1)}%`}
    </span>
  );
});

export function OverviewMetricsView({
  items,
  labels,
  loading,
  locale,
  timeZone,
  interval,
  animationKey,
  comparisonLabel,
}: OverviewMetricsViewProps) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="px-0">
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item, index) => {
            const label = labels[item.key];
            const hasDelta =
              typeof item.delta === "number" && Number.isFinite(item.delta);
            const effectiveDelta = hasDelta ? (item.delta ?? 0) : null;

            return (
              <div key={label} className={metricCellBorderClasses(index)}>
                <div className="relative min-h-[74px]">
                  <div className="absolute inset-y-0 right-0 w-1/2 min-w-0">
                    <MetricAreaChart
                      points={item.trend}
                      color={METRIC_AREA_COLOR}
                      locale={locale}
                      timeZone={timeZone}
                      interval={interval}
                      label={label}
                      formatValue={item.formatTrendValue}
                      animationKey={animationKey}
                      comparisonPoints={item.comparisonTrend}
                      comparisonColor={COMPARISON_AREA_COLOR}
                      comparisonLabel={comparisonLabel}
                    />
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-h-[74px] min-w-0 flex-col justify-between px-3 py-2.5">
                    <p className="truncate text-xs text-muted-foreground mb-4">
                      {label}
                    </p>
                    <div>
                      <AutoResizer initial>
                        <AutoTransition initial>
                          {loading ? (
                            <div
                              key="loading"
                              className="inline-flex h-6 items-center"
                            >
                              <Spinner className="size-5" />
                            </div>
                          ) : (
                            <p
                              key="value"
                              className="inline-flex h-6 items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                            >
                              <span>{item.value}</span>
                              <ChangeRateInline
                                value={effectiveDelta}
                                lowerIsBetter={item.lowerIsBetter}
                              />
                            </p>
                          )}
                        </AutoTransition>
                      </AutoResizer>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
  );
}
