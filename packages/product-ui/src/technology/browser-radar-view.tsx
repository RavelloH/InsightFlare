import { memo, useMemo } from "react";
import { AsyncContent as ContentSwitch } from "@insightflare/ui/async-content";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiPulseLine } from "@remixicon/react";

import {
  buildPerformanceRadarMaxByMetric,
  PerformanceRadarChart,
  type PerformanceRadarMetricKey,
  type PerformanceRadarMetricLabels,
  type PerformanceRadarMetrics,
} from "../charts";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
] as const;
const COMPARISON_CHART_COLOR = "var(--color-chart-secondary)";

export interface BrowserRadarItem {
  readonly browser: string;
  readonly metrics: PerformanceRadarMetrics;
}

export interface BrowserRadarLabels {
  readonly title: string;
  readonly subtitle: string;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly metrics: PerformanceRadarMetricLabels;
}

export interface BrowserRadarViewProps {
  readonly labels: BrowserRadarLabels;
  readonly locale: string;
  readonly loading: boolean;
  readonly items: ReadonlyArray<BrowserRadarItem>;
  readonly comparisonItems: ReadonlyArray<BrowserRadarItem>;
  readonly comparisonLabel: string;
}

function SingleBrowserRadar({
  item,
  comparisonItem,
  comparisonLabel,
  color,
  locale,
  maxByMetric,
  metricLabels,
}: {
  item: BrowserRadarItem;
  comparisonItem?: BrowserRadarItem;
  comparisonLabel: string;
  color: string;
  locale: string;
  maxByMetric: Record<PerformanceRadarMetricKey, number>;
  metricLabels: Record<PerformanceRadarMetricKey, string>;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <PerformanceRadarChart
        itemLabel={item.browser}
        metrics={item.metrics}
        maxByMetric={maxByMetric}
        metricLabels={metricLabels}
        color={color}
        locale={locale}
        comparisonMetrics={comparisonItem?.metrics}
        comparisonColor={COMPARISON_CHART_COLOR}
        comparisonLabel={comparisonLabel}
      />
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className="size-2.5 shrink-0 rounded-none"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium">{item.browser}</span>
        </div>
        {comparisonItem ? (
          <div className="flex items-center gap-1.5">
            <span
              className="size-2.5 shrink-0 rounded-none"
              style={{ backgroundColor: COMPARISON_CHART_COLOR }}
            />
            <span className="font-medium">{comparisonLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const BrowserRadarView = memo(function BrowserRadarView({
  labels,
  locale,
  loading,
  items,
  comparisonItems,
  comparisonLabel,
}: BrowserRadarViewProps) {
  const comparisonByBrowser = useMemo(
    () => new Map(comparisonItems.map((item) => [item.browser, item])),
    [comparisonItems],
  );

  const maxByMetric = useMemo(() => {
    const metrics = items.flatMap((item) => [
      item.metrics,
      comparisonByBrowser.get(item.browser)?.metrics,
    ]);
    return buildPerformanceRadarMaxByMetric(
      metrics.filter((item): item is PerformanceRadarMetrics => Boolean(item)),
    );
  }, [comparisonByBrowser, items]);

  const hasContent = items.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiPulseLine className="size-4" />
          {labels.title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{labels.subtitle}</p>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading}
          hasContent={hasContent}
          loadingLabel={labels.loadingLabel}
          emptyContent={<p>{labels.emptyLabel}</p>}
          minHeightClassName="min-h-[200px]"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {items.map((item, i) => {
              const color = CHART_COLORS[i % CHART_COLORS.length];
              return (
                <SingleBrowserRadar
                  key={item.browser}
                  item={item}
                  comparisonItem={comparisonByBrowser.get(item.browser)}
                  comparisonLabel={comparisonLabel}
                  color={color}
                  locale={locale}
                  maxByMetric={maxByMetric}
                  metricLabels={labels.metrics}
                />
              );
            })}
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
});
