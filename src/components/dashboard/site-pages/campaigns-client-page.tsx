import { useCallback, useMemo, useState } from "react";

import {
  CampaignBreakdownCard,
  type CampaignBreakdownGroupKey,
} from "@/components/dashboard/campaign-breakdown-card";
import { CampaignShareTrendCard } from "@/components/dashboard/campaign-share-trend-card";
import {
  buildCampaignRows,
  type CampaignRawRowsByTab,
  type CampaignSortKey,
  type CampaignTab,
} from "@/components/dashboard/campaign-utils";
import type { ComparisonTableMetric } from "@/components/dashboard/comparison-table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { TabbedDataTableLoader } from "@/components/dashboard/tabbed-data-table-card";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import { fetchUtmDimension } from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface CampaignsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

const EMPTY_ROWS: CampaignRawRowsByTab["source"] = [];
function emptyRowsUnlessAborted(
  error: unknown,
): CampaignRawRowsByTab["source"] {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return EMPTY_ROWS;
}

export function CampaignsClientPage({
  locale,
  messages,
  siteId,
}: CampaignsClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonQuery = useDashboardComparisonQuery(window, filters);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const [comparisonMetricByGroup, setComparisonMetricByGroup] = useState<
    Record<CampaignBreakdownGroupKey, ComparisonTableMetric>
  >({ acquisition: "views", signals: "views" });
  const handleComparisonMetricChange = useCallback(
    (group: CampaignBreakdownGroupKey, metric: ComparisonTableMetric) => {
      setComparisonMetricByGroup((current) => ({
        ...current,
        [group]: metric,
      }));
    },
    [],
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

  const loader = useCallback<
    TabbedDataTableLoader<
      CampaignTab,
      ReturnType<typeof buildCampaignRows>[number],
      CampaignSortKey
    >
  >(
    async ({ tab, cursor, limit, search, signal, sort }) => {
      try {
        const comparisonMetric =
          tab === "term" || tab === "content"
            ? comparisonMetricByGroup.signals
            : comparisonMetricByGroup.acquisition;
        const payload = await fetchUtmDimension(
          siteId,
          requestWindow,
          tab,
          requestFilters,
          {
            cursor,
            direction: sort.direction,
            limit,
            search,
            signal,
            sort:
              sort.key === "current" ||
              sort.key === "reference" ||
              sort.key === "change"
                ? comparisonMetric
                : sort.key,
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
        const items = buildCampaignRows(
          payload.items,
          tab,
          messages.campaigns.notSet,
        );
        return {
          items,
          pagination: {
            limit,
            returned: items.length,
            hasMore: payload.pagination.hasMore,
            nextCursor: payload.pagination.nextCursor,
          },
        };
      } catch (error) {
        const items = buildCampaignRows(
          emptyRowsUnlessAborted(error),
          tab,
          messages.campaigns.notSet,
        );
        return {
          items,
          pagination: {
            limit,
            returned: items.length,
            hasMore: false,
            nextCursor: null,
          },
        };
      }
    },
    [
      comparisonMetricByGroup.acquisition,
      comparisonMetricByGroup.signals,
      comparisonQuery,
      messages.campaigns.notSet,
      requestFilters,
      requestWindow,
      siteId,
    ],
  );
  const comparisonKey = comparisonQuery
    ? `${comparisonQuery.mode}:${comparisonQuery.window.from}:${comparisonQuery.window.to}:${comparisonFiltersKey}`
    : "none";
  const requestKey = `${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${comparisonKey}:${locale}`;

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.campaigns.title}
        subtitle={messages.campaigns.subtitle}
      />

      <CampaignShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
      />

      <CampaignBreakdownCard
        locale={locale}
        messages={messages}
        loader={loader}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
        comparisonMetricByGroup={comparisonMetricByGroup}
        onComparisonMetricChange={handleComparisonMetricChange}
        requestKey={requestKey}
      />
    </div>
  );
}
