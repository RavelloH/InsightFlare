import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { PageHeading } from "@/components/dashboard/page-heading";
import { ReferrerBreakdownCard } from "@/components/dashboard/referrer-breakdown-card";
import { ReferrerPerformanceRadarCard } from "@/components/dashboard/referrer-performance-radar-card";
import { ReferrerShareTrendCard } from "@/components/dashboard/referrer-share-trend-card";
import { ReferrerSummarySection } from "@/components/dashboard/referrer-summary-section";
import { buildReferrerRowsByTab } from "@/components/dashboard/referrer-utils";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  fetchOverviewSourceCardTab,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
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

const EMPTY_ROWS: OverviewTabRows = [];

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
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const requestFilters = useMemo(() => ({ ...filters }), [filtersKey]);
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

  const { data: rowsByTab, isFetching: loading } = useQuery({
    queryKey: [
      "dashboard",
      "referrer-breakdown",
      siteId,
      showSourceLinkTab,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const [domain, link, channel] = await Promise.all([
        fetchOverviewSourceCardTab(
          siteId,
          requestWindow,
          "domain",
          requestFilters,
          { limit: 100, signal },
        ),
        showSourceLinkTab
          ? fetchOverviewSourceCardTab(
              siteId,
              requestWindow,
              "link",
              requestFilters,
              { limit: 100, signal },
            )
          : Promise.resolve(EMPTY_ROWS),
        fetchOverviewSourceCardTab(
          siteId,
          requestWindow,
          "channel",
          requestFilters,
          { limit: 100, signal },
        ),
      ]);
      return { domain, link, channel };
    },
    placeholderData: keepPreviousData,
    enabled: typeof window !== "undefined",
  });
  const resolvedRowsByTab = rowsByTab ?? {
    domain: EMPTY_ROWS,
    link: EMPTY_ROWS,
    channel: EMPTY_ROWS,
  };

  const normalizedRowsByTab = useMemo(
    () =>
      buildReferrerRowsByTab(
        resolvedRowsByTab,
        messages.overview.direct,
        messages.overview.channelLabels,
      ),
    [
      messages.overview.channelLabels,
      messages.overview.direct,
      resolvedRowsByTab,
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
        rowsByTab={normalizedRowsByTab}
        loading={loading}
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
        rowsByTab={normalizedRowsByTab}
        loading={loading}
        showSourceLinkTab={showSourceLinkTab}
      />
    </div>
  );
}
