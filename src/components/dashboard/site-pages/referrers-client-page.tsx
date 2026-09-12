import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeading } from "@/components/dashboard/page-heading";
import { ReferrerBreakdownCard } from "@/components/dashboard/referrer-breakdown-card";
import { ReferrerPerformanceRadarCard } from "@/components/dashboard/referrer-performance-radar-card";
import { ReferrerShareTrendCard } from "@/components/dashboard/referrer-share-trend-card";
import { ReferrerSummarySection } from "@/components/dashboard/referrer-summary-section";
import {
  buildReferrerRowsByTab,
  type ReferrerSortKey,
  type ReferrerTab,
} from "@/components/dashboard/referrer-utils";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { TabbedDataTableLoader } from "@/components/dashboard/tabbed-data-table-card";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import {
  fetchOverviewSourceCardTab,
  fetchReferrerSummary,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ReferrersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  showSourceLinkTab?: boolean;
}

export function ReferrersClientPage({
  locale,
  messages,
  siteId,
  pathname,
  showSourceLinkTab = true,
}: ReferrersClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const comparisonQuery = useDashboardComparisonQuery(window, filters);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const requestFilters = filters;
  const requestWindow = useMemo(
    () => ({
      preset: window.preset,
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.preset, window.timeZone, window.to],
  );
  const requestKey = `${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${locale}:${filtersKey}`;
  const summaryQuery = useQuery({
    queryKey: [
      "dashboard",
      "referrer-summary",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? "none",
      comparisonQuery?.window.to ?? "none",
      comparisonQuery?.window.interval ?? "none",
      comparisonQuery?.window.timeZone ?? "none",
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const [current, comparison] = await Promise.all([
        fetchReferrerSummary(siteId, requestWindow, requestFilters, {
          topN: 5,
          signal,
        }),
        comparisonQuery
          ? fetchReferrerSummary(
              siteId,
              comparisonQuery.window,
              comparisonQuery.filters,
              { topN: 5, signal },
            )
          : Promise.resolve(null),
      ]);
      return { current, comparison };
    },
    enabled: typeof window !== "undefined",
  });
  const loader = useCallback<
    TabbedDataTableLoader<
      ReferrerTab,
      ReturnType<typeof buildReferrerRowsByTab>["domain"][number],
      ReferrerSortKey
    >
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const page = await fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        tab,
        requestFilters,
        {
          limit,
          search,
          sort: sort.key,
          direction: sort.direction,
          cursor,
          signal,
        },
      );
      const normalized = buildReferrerRowsByTab(
        {
          domain: tab === "domain" ? page.items : [],
          link: tab === "link" ? page.items : [],
          channel: tab === "channel" ? page.items : [],
        },
        messages.overview.direct,
        messages.overview.channelLabels,
      );
      return {
        items: normalized[tab],
        pagination: page.pagination,
      };
    },
    [
      messages.overview.channelLabels,
      messages.overview.direct,
      requestFilters,
      requestWindow,
      siteId,
    ],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.referrers.title}
        subtitle={messages.referrers.subtitle}
      />

      <ReferrerSummarySection
        locale={locale}
        messages={messages}
        summary={summaryQuery.data?.current.data ?? null}
        comparisonSummary={summaryQuery.data?.comparison?.data ?? null}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
        loading={summaryQuery.isFetching}
        hideSummaryCard
      />

      <ReferrerShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
      />

      <ReferrerPerformanceRadarCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
      />

      <ReferrerBreakdownCard
        locale={locale}
        messages={messages}
        pathname={pathname}
        filters={requestFilters}
        requestKey={requestKey}
        loader={loader}
        showSourceLinkTab={showSourceLinkTab}
      />
    </div>
  );
}
