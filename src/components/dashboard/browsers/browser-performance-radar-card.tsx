import { memo, useMemo } from "react";
import { BrowserRadarView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { fetchBrowserRadar } from "@/lib/dashboard/client/data/index";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserRadarItem } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildBrowserRadarLabels } from "@/lib/product-ui-labels/technology";
function emptyRadarUnlessAborted(error: unknown): BrowserRadarItem[] {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return [];
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
    const labels = useMemo(() => buildBrowserRadarLabels(messages), [messages]);

    return (
      <BrowserRadarView
        labels={labels}
        locale={locale}
        loading={loading}
        items={data}
        comparisonItems={comparisonData}
        comparisonLabel={comparisonLabel}
      />
    );
  },
);
