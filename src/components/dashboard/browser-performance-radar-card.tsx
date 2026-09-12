import { memo, useMemo } from "react";
import { RiPulseLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  buildPerformanceRadarMaxByMetric,
  PerformanceRadarChart,
  type PerformanceRadarMetricKey,
} from "@/components/dashboard/charts/performance-radar-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchBrowserRadar } from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserRadarItem } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
] as const;

const COMPARISON_CHART_COLOR = "var(--color-compare-primary)";

function emptyRadarUnlessAborted(error: unknown): BrowserRadarItem[] {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return [];
}

/* ---------- single browser radar ---------- */

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
  locale: Locale;
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
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium">{item.browser}</span>
        </div>
        {comparisonItem ? (
          <div className="flex items-center gap-1.5">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: COMPARISON_CHART_COLOR }}
            />
            <span className="font-medium">{comparisonLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- main component ---------- */

interface BrowserPerformanceRadarCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

export const BrowserPerformanceRadarCard = memo(
  function BrowserPerformanceRadarCard({
    locale,
    messages,
    siteId,
    window: tw,
    filters,
  }: BrowserPerformanceRadarCardProps) {
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const comparisonQuery = useDashboardComparisonQuery(tw, filters);
    const comparisonFiltersKey = useMemo(
      () =>
        comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none",
      [comparisonQuery],
    );
    const { data: response, isPending: loading } = useQuery({
      queryKey: [
        "dashboard",
        "browser-radar",
        siteId,
        tw.from,
        tw.to,
        tw.timeZone,
        filtersKey,
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        comparisonQuery?.window.interval ?? "none",
        comparisonQuery?.window.timeZone ?? "none",
        comparisonFiltersKey,
      ],
      queryFn: async ({ signal }) => {
        const fetchRadarData = (
          requestedWindow: TimeWindow,
          requestedFilters: FilterDocument,
        ) =>
          fetchBrowserRadar(siteId, requestedWindow, requestedFilters, {
            signal,
          })
            .then((result) =>
              Array.isArray(result.data)
                ? result.data
                : ([] as BrowserRadarItem[]),
            )
            .catch(emptyRadarUnlessAborted);

        const [current, comparison] = await Promise.all([
          fetchRadarData(tw, filters),
          comparisonQuery
            ? fetchRadarData(comparisonQuery.window, comparisonQuery.filters)
            : Promise.resolve(null),
        ]);
        return { current, comparison };
      },
      enabled: !import.meta.env.SSR,
    });
    const data = response?.current ?? [];
    const comparisonData = response?.comparison ?? [];
    const comparisonLabel = dashboardComparisonLabel(messages, comparisonQuery);
    const comparisonByBrowser = useMemo(
      () => new Map(comparisonData.map((item) => [item.browser, item])),
      [comparisonData],
    );

    const metricLabels = useMemo(
      () => ({
        duration: messages.browsers.radarDuration,
        engagement: messages.browsers.radarEngagement,
        depth: messages.browsers.radarDepth,
        loyalty: messages.browsers.radarLoyalty,
        frequency: messages.browsers.radarFrequency,
        traffic: messages.browsers.radarTraffic,
      }),
      [messages],
    );

    const maxByMetric = useMemo(() => {
      const metrics = data.flatMap((item) => [
        item.metrics,
        comparisonByBrowser.get(item.browser)?.metrics,
      ]);
      return buildPerformanceRadarMaxByMetric(
        metrics.filter((item): item is BrowserRadarItem["metrics"] =>
          Boolean(item),
        ),
      );
    }, [comparisonByBrowser, data]);

    const hasContent = data.length > 0;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {messages.browsers.radarTitle}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {messages.browsers.radarSubtitle}
          </p>
        </CardHeader>
        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={hasContent}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{messages.common.noData}</p>}
            minHeightClassName="min-h-[200px]"
          >
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {data.map((item, i) => {
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
                    metricLabels={metricLabels}
                  />
                );
              })}
            </div>
          </ContentSwitch>
        </CardContent>
      </Card>
    );
  },
);
