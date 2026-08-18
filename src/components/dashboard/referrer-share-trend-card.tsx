import { useMemo } from "react";

import { DIRECT_REFERRER_FILTER_VALUE } from "@/components/dashboard/referrer-utils";
import {
  ShareTrendCard,
  type ShareTrendFetcher,
} from "@/components/dashboard/share-trend-card";
import { fetchReferrerTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ReferrerShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

function ReferrerTrendPanel({
  locale,
  messages,
  siteId,
  window,
  filters,
}: ReferrerShareTrendCardProps) {
  const fetchTrend = useMemo<ShareTrendFetcher>(() => {
    return async (nextSiteId, nextWindow, nextFilters, options) => {
      const payload = await fetchReferrerTrend(
        nextSiteId,
        nextWindow,
        nextFilters,
        options,
      );

      return {
        ...payload,
        series: payload.series.map((series) => ({
          ...series,
          label:
            series.label === DIRECT_REFERRER_FILTER_VALUE
              ? messages.overview.direct
              : series.label,
        })),
      };
    };
  }, [messages.overview.direct]);

  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      queryKey={["referrer", messages.overview.direct]}
      title={messages.overview.sourceTab}
      fetchTrend={fetchTrend}
      otherLabel={messages.referrers.longTail}
    />
  );
}

export function ReferrerShareTrendCard(props: ReferrerShareTrendCardProps) {
  return <ReferrerTrendPanel {...props} />;
}
