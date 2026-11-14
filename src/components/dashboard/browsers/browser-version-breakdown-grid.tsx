import { memo, useMemo } from "react";
import { BrowserVersionBreakdownView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import { fetchBrowserVersionBreakdown } from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserVersionBreakdownBrowser,
  BrowserVersionBreakdownData,
  BrowserVersionSlice,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildBrowserVersionBreakdownLabels } from "@/lib/product-ui-labels/technology";
interface BrowserVersionBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}
interface BrowserVersionSliceDisplay extends BrowserVersionSlice {
  displayLabel: string;
  share: number;
}
interface BrowserVersionBrowserDisplay extends BrowserVersionBreakdownBrowser {
  versions: BrowserVersionSliceDisplay[];
}
function emptyBrowserVersionBreakdown(): BrowserVersionBreakdownData {
  return {
    ok: true,
    data: [],
  };
}
function versionDisplayLabel(
  slice: BrowserVersionSlice,
  browserName: string,
  messages: AppMessages,
): string {
  if (slice.isOther) return messages.browsers.otherLabel;
  if (slice.isUnknown) return messages.common.unknown;
  return `${browserName} ${slice.label}`.trim();
}
function buildVersionCardData(
  data: BrowserVersionBreakdownData,
  messages: AppMessages,
): BrowserVersionBrowserDisplay[] {
  return data.data.map((browser) => ({
    ...browser,
    versions: browser.versions.map((slice) => ({
      ...slice,
      displayLabel: versionDisplayLabel(slice, browser.browser, messages),
      share: browser.visitors > 0 ? slice.visitors / browser.visitors : 0,
    })),
  }));
}
function emptyBreakdownUnlessAborted(
  error: unknown,
): BrowserVersionBreakdownData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyBrowserVersionBreakdown();
}
export const BrowserVersionBreakdownGrid = memo(
  function BrowserVersionBreakdownGrid({
    locale,
    messages,
    siteId,
    window,
    filters,
    comparisonQuery,
    comparisonLabel,
  }: BrowserVersionBreakdownGridProps) {
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const comparisonFiltersKey = useMemo(
      () =>
        comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none",
      [comparisonQuery],
    );
    const { data, isFetching, isPending } = useQuery({
      queryKey: [
        "dashboard",
        "browser-version-breakdown",
        siteId,
        window.from,
        window.to,
        window.timeZone,
        filtersKey,
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        comparisonQuery?.window.timeZone ?? "none",
        comparisonFiltersKey,
      ],
      queryFn: async ({ signal }) => {
        const fetchBreakdown = (
          requestedWindow: TimeWindow,
          requestedFilters: FilterDocument,
        ) =>
          fetchBrowserVersionBreakdown(
            siteId,
            requestedWindow,
            requestedFilters,
            {
              browserLimit: 0,
              versionLimit: 5,
              signal,
            },
          ).catch(emptyBreakdownUnlessAborted);

        const [current, comparison] = await Promise.all([
          fetchBreakdown(window, filters),
          comparisonQuery
            ? fetchBreakdown(comparisonQuery.window, comparisonQuery.filters)
            : Promise.resolve(null),
        ]);
        return { current, comparison };
      },
      enabled: !import.meta.env.SSR,
    });
    const breakdownData = useMemo(
      () => data?.current ?? emptyBrowserVersionBreakdown(),
      [data?.current],
    );
    const comparisonBreakdownData = useMemo(
      () => data?.comparison ?? undefined,
      [data?.comparison],
    );

    const browsers = useMemo(
      () => buildVersionCardData(breakdownData, messages),
      [breakdownData, messages],
    );
    const comparisonBrowsers = useMemo(
      () =>
        comparisonBreakdownData
          ? buildVersionCardData(comparisonBreakdownData, messages)
          : undefined,
      [comparisonBreakdownData, messages],
    );
    const showOverlayLoading = isFetching && data !== undefined;
    const labels = useMemo(
      () => buildBrowserVersionBreakdownLabels(messages),
      [messages],
    );

    return (
      <BrowserVersionBreakdownView
        locale={locale}
        labels={labels}
        browsers={browsers}
        comparisonBrowsers={comparisonBrowsers}
        comparisonLabel={comparisonLabel}
        loading={isPending}
        refreshing={showOverlayLoading}
      />
    );
  },
);
