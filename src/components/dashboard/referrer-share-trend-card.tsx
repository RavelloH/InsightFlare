import { memo, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { DIRECT_REFERRER_FILTER_VALUE } from "@/components/dashboard/referrer-utils";
import { ShareTrendChartCard } from "@/components/dashboard/share-trend-card";
import type { TrafficChannelId } from "@/lib/analytics/traffic-channel-rules";
import { fetchReferrerAndChannelTrend } from "@/lib/dashboard/client-referrer-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
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

function emptyTrendData(interval: TimeWindow["interval"]): BrowserTrendData {
  return {
    ok: true,
    interval,
    series: [],
    data: [],
  };
}

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

function asBrowserTrendData(
  interval: BrowserTrendData["interval"],
  dimension: Pick<BrowserTrendData, "series" | "data">,
): BrowserTrendData {
  return {
    ok: true,
    interval,
    ...dimension,
  };
}

function ReferrerTrendPanel({
  locale,
  messages,
  siteId,
  window,
  filters,
}: ReferrerShareTrendCardProps) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const currentDataWindow = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.timeZone, window.to],
  );
  const fallbackTrendData = useMemo(
    () => ({
      ok: true as const,
      interval: window.interval,
      source: emptyTrendData(window.interval),
      channel: emptyTrendData(window.interval),
    }),
    [window.interval],
  );
  const {
    data: trendQueryData,
    isFetching,
    isPending,
  } = useQuery({
    queryKey: [
      "dashboard",
      "referrer-channel-trend",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      5,
    ],
    queryFn: async ({ signal }) => ({
      trendData: await fetchReferrerAndChannelTrend(siteId, window, filters, {
        limit: 5,
        signal,
      }).catch((error) =>
        fallbackUnlessAborted(error, () => fallbackTrendData),
      ),
      dataWindow: currentDataWindow,
    }),
    enabled: typeof window !== "undefined",
    placeholderData: keepPreviousData,
  });
  const loading = isPending || isFetching;
  const trendData = trendQueryData?.trendData ?? fallbackTrendData;
  const dataWindow = trendQueryData?.dataWindow ?? currentDataWindow;
  const hydrated = Boolean(trendQueryData);
  const sourceTrendData = useMemo(
    () => asBrowserTrendData(trendData.interval, trendData.source),
    [trendData.interval, trendData.source],
  );
  const channelTrendData = useMemo(
    () => asBrowserTrendData(trendData.interval, trendData.channel),
    [trendData.channel, trendData.interval],
  );

  const formatSourceLabel = useMemo(
    () => (series: BrowserTrendSeries) =>
      series.label === DIRECT_REFERRER_FILTER_VALUE
        ? messages.overview.direct
        : series.label,
    [messages.overview.direct],
  );
  const formatChannelLabel = useMemo(
    () => (series: BrowserTrendSeries) =>
      messages.overview.channelLabels[series.label as TrafficChannelId] ??
      series.label,
    [messages.overview.channelLabels],
  );

  return (
    <div className="space-y-6">
      <ShareTrendChartCard
        locale={locale}
        messages={messages}
        title={messages.overview.sourceTab}
        trendData={sourceTrendData}
        dataWindow={dataWindow}
        loading={loading}
        hydrated={hydrated}
        otherLabel={messages.referrers.longTail}
        formatSeriesLabel={formatSourceLabel}
      />
      <ShareTrendChartCard
        locale={locale}
        messages={messages}
        title={messages.overview.channelTab}
        trendData={channelTrendData}
        dataWindow={dataWindow}
        loading={loading}
        hydrated={hydrated}
        otherLabel={messages.referrers.channelLongTail}
        formatSeriesLabel={formatChannelLabel}
      />
    </div>
  );
}

export const ReferrerShareTrendCard = memo(function ReferrerShareTrendCard(
  props: ReferrerShareTrendCardProps,
) {
  return <ReferrerTrendPanel {...props} />;
});
