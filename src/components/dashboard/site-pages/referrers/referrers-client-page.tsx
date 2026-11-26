import { useCallback, useMemo, useState } from "react";
import { PageHeading } from "@insightflare/ui/page-heading";
import { useQuery } from "@tanstack/react-query";

import type { TabbedDataTableLoader } from "@/components/dashboard/common/tabbed-data-table-card";
import type { ComparisonTableMetric } from "@/components/dashboard/comparison/comparison-table";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import {
  ReferrerBreakdownCard,
  type ReferrerBreakdownGroupKey,
} from "@/components/dashboard/referrers/referrer-breakdown-card";
import { ReferrerPerformanceRadarCard } from "@/components/dashboard/referrers/referrer-performance-radar-card";
import { ReferrerShareTrendCard } from "@/components/dashboard/referrers/referrer-share-trend-card";
import { ReferrerSummarySection } from "@/components/dashboard/referrers/referrer-summary-section";
import {
  buildReferrerRowsByTab,
  type ReferrerSortKey,
  type ReferrerTab,
} from "@/components/dashboard/referrers/referrer-utils";
import { useDashboardDeferredReadTransport } from "@/components/dashboard/shell/dashboard-query-provider";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import {
  fetchOverviewSourceCardTab,
  fetchReferrerSummary,
} from "@/lib/dashboard/client/data/index";
import { REFERRER_SUMMARY_TOP_N } from "@/lib/dashboard/client/data/referrers";
import { type DeferredPrivateReads } from "@/lib/dashboard/client/request";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import {
  capturePerceptionGuard,
  observeLoadedDimension,
} from "@/lib/perception-search/runtime";
interface ReferrersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  showSourceLinkTab?: boolean;
  deferredReads?: DeferredPrivateReads | null;
}
export function ReferrersClientPage({
  locale,
  messages,
  siteId,
  pathname,
  showSourceLinkTab = true,
  deferredReads,
}: ReferrersClientPageProps) {
  const { filters, window, queryReady } = useDashboardQuery() as {
    queryReady: boolean;
    filters: FilterDocument;
    window: TimeWindow;
  };
  const transport = useDashboardDeferredReadTransport(deferredReads);
  const comparisonQuery = useDashboardComparisonQuery(window, filters);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const requestFilters = filters;
  const [comparisonMetricByGroup, setComparisonMetricByGroup] = useState<
    Record<ReferrerBreakdownGroupKey, ComparisonTableMetric>
  >({ source: "views", channel: "views" });
  const handleComparisonMetricChange = useCallback(
    (group: ReferrerBreakdownGroupKey, metric: ComparisonTableMetric) => {
      setComparisonMetricByGroup((current) => ({
        ...current,
        [group]: metric,
      }));
    },
    [],
  );
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
  const comparisonKey = comparisonQuery
    ? `${comparisonQuery.mode}:${comparisonQuery.window.from}:${comparisonQuery.window.to}:${comparisonFiltersKey}`
    : "none";
  const requestKey = `${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${locale}:${filtersKey}:${comparisonKey}`;
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
          topN: REFERRER_SUMMARY_TOP_N,
          signal,
          ...(transport ? { transport } : {}),
        }),
        comparisonQuery
          ? fetchReferrerSummary(
              siteId,
              comparisonQuery.window,
              comparisonQuery.filters,
              {
                topN: REFERRER_SUMMARY_TOP_N,
                signal,
                ...(transport ? { transport } : {}),
              },
            )
          : Promise.resolve(null),
      ]);
      return { current, comparison };
    },
    enabled: queryReady,
  });
  const loader = useCallback<
    TabbedDataTableLoader<
      ReferrerTab,
      ReturnType<typeof buildReferrerRowsByTab>["domain"][number],
      ReferrerSortKey
    >
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const observationGuard =
        tab === "domain" ? capturePerceptionGuard(siteId) : null;
      const comparisonMetric =
        tab === "channel"
          ? comparisonMetricByGroup.channel
          : comparisonMetricByGroup.source;
      const page = await fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        tab,
        requestFilters,
        {
          limit,
          search,
          sort:
            sort.key === "current" ||
            sort.key === "reference" ||
            sort.key === "change"
              ? comparisonMetric
              : sort.key,
          direction: sort.direction,
          cursor,
          signal,
          ...(transport ? { transport } : {}),
          comparison: comparisonQuery,
          comparisonMetric,
          comparisonSortBy:
            sort.key === "current" ||
            sort.key === "reference" ||
            sort.key === "change"
              ? sort.key
              : undefined,
        },
      );
      if (tab === "domain" && !signal.aborted) {
        observeLoadedDimension(
          siteId,
          "referrer.domain",
          page.items.map((row) => row.value ?? row.label),
          observationGuard,
        );
      }
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
      comparisonMetricByGroup.channel,
      comparisonMetricByGroup.source,
      comparisonQuery,
      siteId,
      transport,
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
        loading={summaryQuery.isPending || summaryQuery.isFetching}
        hideSummaryCard
      />

      <ReferrerShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
        transport={transport}
      />

      <ReferrerPerformanceRadarCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
        transport={transport}
      />

      <ReferrerBreakdownCard
        locale={locale}
        messages={messages}
        pathname={pathname}
        filters={requestFilters}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
        comparisonMetricByGroup={comparisonMetricByGroup}
        onComparisonMetricChange={handleComparisonMetricChange}
        requestKey={requestKey}
        loader={loader}
        queryEnabled={queryReady}
        showSourceLinkTab={showSourceLinkTab}
      />
    </div>
  );
}
