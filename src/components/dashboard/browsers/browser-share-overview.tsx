import { memo, useMemo } from "react";
import { TechnologyShareOverviewView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import { shareTrendQueryOptions } from "@/components/dashboard/sharing/share-trend-card";
import { useDashboardQueryReady } from "@/components/dashboard/shell/dashboard-query-provider";
import {
  fetchBrowserEngineTrend,
  fetchBrowserTrend,
} from "@/lib/dashboard/client/data/index";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildBrowserShareOverviewLabels } from "@/lib/product-ui-labels/technology";
function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

interface BrowserShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  transport?: PrivateReadTransport;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}
export const BrowserShareOverview = memo(function BrowserShareOverview({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
  transport,
  comparisonQuery,
  comparisonLabel,
}: BrowserShareOverviewProps) {
  const enabled = useDashboardQueryReady();
  const primaryQuery = useQuery({
    ...shareTrendQueryOptions({
      siteId,
      window: tw,
      filters,
      queryKey: ["browser"],
      fetchTrend: fetchBrowserTrend,
      comparisonQuery: comparisonQuery ?? null,
      transport,
    }),
    enabled,
  });
  const secondaryQuery = useQuery({
    ...shareTrendQueryOptions({
      siteId,
      window: tw,
      filters,
      queryKey: ["browser-engine"],
      fetchTrend: fetchBrowserEngineTrend,
      comparisonQuery: comparisonQuery ?? null,
      transport,
    }),
    enabled,
  });
  const browserTrend = useMemo(
    () => primaryQuery.data?.trendData ?? emptyTrend(),
    [primaryQuery.data?.trendData],
  );
  const engineTrend = useMemo(
    () => secondaryQuery.data?.trendData ?? emptyTrend(),
    [secondaryQuery.data?.trendData],
  );
  const comparisonBrowserTrend =
    primaryQuery.data?.comparisonTrendData ?? undefined;
  const comparisonEngineTrend =
    secondaryQuery.data?.comparisonTrendData ?? undefined;
  const browserItems = useMemo(
    () =>
      browserTrend.series.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.visitors,
        isOther: item.isOther,
      })),
    [browserTrend.series],
  );
  const engineItems = useMemo(
    () =>
      engineTrend.series.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.visitors,
        isOther: item.isOther,
      })),
    [engineTrend.series],
  );
  const comparisonBrowserItems = useMemo(
    () =>
      comparisonBrowserTrend?.series.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.visitors,
        isOther: item.isOther,
      })),
    [comparisonBrowserTrend?.series],
  );
  const comparisonEngineItems = useMemo(
    () =>
      comparisonEngineTrend?.series.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.visitors,
        isOther: item.isOther,
      })),
    [comparisonEngineTrend?.series],
  );
  const showOverlayLoading =
    (primaryQuery.isFetching || secondaryQuery.isFetching) &&
    Boolean(primaryQuery.data && secondaryQuery.data);
  const showInitialLoading = primaryQuery.isPending || secondaryQuery.isPending;
  const labels = useMemo(
    () => buildBrowserShareOverviewLabels(messages),
    [messages],
  );
  const primary = useMemo(
    () => ({ items: browserItems, comparisonItems: comparisonBrowserItems }),
    [browserItems, comparisonBrowserItems],
  );
  const secondary = useMemo(
    () => ({ items: engineItems, comparisonItems: comparisonEngineItems }),
    [engineItems, comparisonEngineItems],
  );

  return (
    <TechnologyShareOverviewView
      variant="browser"
      locale={locale}
      labels={labels}
      primary={primary}
      secondary={secondary}
      comparisonLabel={comparisonLabel}
      loading={showInitialLoading}
      refreshing={showOverlayLoading}
    />
  );
});
