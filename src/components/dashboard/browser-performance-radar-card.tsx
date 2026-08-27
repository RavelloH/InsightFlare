import { useMemo } from "react";
import { RiPulseLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  PERFORMANCE_RADAR_METRIC_KEYS,
  PerformanceRadarChart,
  type PerformanceRadarMetricKey,
} from "@/components/dashboard/charts/performance-radar-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchBrowserRadar } from "@/lib/dashboard/client-data";
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

function emptyRadarUnlessAborted(error: unknown): BrowserRadarItem[] {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return [];
}

/* ---------- single browser radar ---------- */

function SingleBrowserRadar({
  item,
  color,
  locale,
  maxByMetric,
  metricLabels,
}: {
  item: BrowserRadarItem;
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
      />
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className="size-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        <span className="font-medium">{item.browser}</span>
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

export function BrowserPerformanceRadarCard({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: BrowserPerformanceRadarCardProps) {
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const { data: response, isPending: loading } = useQuery({
    queryKey: [
      "dashboard",
      "browser-radar",
      siteId,
      tw.from,
      tw.to,
      tw.timeZone,
      filtersKey,
    ],
    queryFn: ({ signal }) =>
      fetchBrowserRadar(siteId, tw, filters, { signal })
        .then((result) =>
          Array.isArray(result.data) ? result.data : ([] as BrowserRadarItem[]),
        )
        .catch(emptyRadarUnlessAborted),
    enabled: !import.meta.env.SSR,
  });
  const data = response ?? [];

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
    const result = {} as Record<PerformanceRadarMetricKey, number>;
    for (const key of PERFORMANCE_RADAR_METRIC_KEYS) {
      result[key] = Math.max(...data.map((i) => i.metrics[key]), 0);
    }
    return result;
  }, [data]);

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
}
