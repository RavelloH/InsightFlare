import { memo, useMemo } from "react";
import { TechnologyShareOverviewView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import {
  fetchBrowserEngineTrend,
  fetchBrowserTrend,
} from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildBrowserShareOverviewLabels } from "@/lib/product-ui-labels/technology";
function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}
function emptyTrendUnlessAborted(error: unknown): BrowserTrendData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyTrend();
}
interface BrowserShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}
export const BrowserShareOverview = memo(function BrowserShareOverview({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
  comparisonQuery,
  comparisonLabel,
}: BrowserShareOverviewProps) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const { data, isFetching, isPending } = useQuery({
    queryKey: [
      "dashboard",
      "browser-share-overview",
      siteId,
      tw.from,
      tw.to,
      tw.interval,
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
      const fetchShareData = async (
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) => {
        const [browserTrend, engineTrend] = await Promise.all([
          fetchBrowserTrend(siteId, requestedWindow, requestedFilters, {
            limit: 5,
            signal,
          }).catch(emptyTrendUnlessAborted),
          fetchBrowserEngineTrend(siteId, requestedWindow, requestedFilters, {
            limit: 5,
            signal,
          }).catch(emptyTrendUnlessAborted),
        ]);
        return { browserTrend, engineTrend };
      };
      const [current, comparison] = await Promise.all([
        fetchShareData(tw, filters),
        comparisonQuery
          ? fetchShareData(comparisonQuery.window, comparisonQuery.filters)
          : Promise.resolve(null),
      ]);
      return { ...current, comparison };
    },
    enabled: !import.meta.env.SSR,
  });
  const browserTrend = useMemo(
    () => data?.browserTrend ?? emptyTrend(),
    [data?.browserTrend],
  );
  const engineTrend = useMemo(
    () => data?.engineTrend ?? emptyTrend(),
    [data?.engineTrend],
  );
  const comparisonBrowserTrend = data?.comparison?.browserTrend;
  const comparisonEngineTrend = data?.comparison?.engineTrend;
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
  const showOverlayLoading = isFetching && data !== undefined;
  const showInitialLoading = isPending;
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
