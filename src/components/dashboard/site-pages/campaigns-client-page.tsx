import { useCallback, useMemo } from "react";

import { CampaignBreakdownCard } from "@/components/dashboard/campaign-breakdown-card";
import { CampaignShareTrendCard } from "@/components/dashboard/campaign-share-trend-card";
import {
  buildCampaignRows,
  type CampaignRawRowsByTab,
  type CampaignTab,
} from "@/components/dashboard/campaign-utils";
import { PageHeading } from "@/components/dashboard/page-heading";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { TabbedDataTableLoader } from "@/components/dashboard/tabbed-data-table-card";
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
function extractDimensionRows(
  payload: unknown,
): CampaignRawRowsByTab["source"] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: CampaignRawRowsByTab["source"] }).data;
  }

  return EMPTY_ROWS;
}

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
      "views" | "sessions"
    >
  >(
    async ({ tab, signal, limit }) => {
      try {
        const payload = await fetchUtmDimension(
          siteId,
          requestWindow,
          tab,
          requestFilters,
          { signal },
        );
        const items = buildCampaignRows(
          extractDimensionRows(payload),
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
    [messages.campaigns.notSet, requestFilters, requestWindow, siteId],
  );
  const requestKey = `${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${locale}`;

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
        requestKey={requestKey}
      />
    </div>
  );
}
