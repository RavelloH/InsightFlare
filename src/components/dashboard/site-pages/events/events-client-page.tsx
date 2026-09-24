import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { EVENT_TREND_MAX_SERIES } from "@/components/dashboard/charts/event-trend-bar-chart";
import {
  DETAIL_QUERY_PARAM,
  DetailModal,
} from "@/components/dashboard/site-pages/common/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { EventTypeDetailClientPage } from "@/components/dashboard/site-pages/events/event-type-detail-client-page";
import {
  EventMetricGrid,
  EventTrendStackedBarCard,
} from "@/components/dashboard/site-pages/events/metrics-components";
import { EventPageHeader } from "@/components/dashboard/site-pages/events/page-header";
import { EventRecordsSection } from "@/components/dashboard/site-pages/events/records-section";
import { parseOverviewCardFilters } from "@/components/dashboard/site-pages/overview/overview-filter-model";
import { OverviewPagesSection } from "@/components/dashboard/site-pages/overview/pages-section";
import { type OverviewPagesSectionCardData } from "@/components/dashboard/site-pages/overview/types";
import {
  fetchEventsSummary,
  fetchEventsTrend,
} from "@/lib/dashboard/client/data/index";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  EventsSummaryData,
  EventsTrendData,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
interface EventsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
}
function emptySummary(): EventsSummaryData {
  return {
    ok: true,
    summary: {
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
    },
    cards: emptySummaryCards(),
  };
}
function emptySummaryCards(): EventsSummaryData["cards"] {
  return {
    event: {
      name: [],
    },
    page: {
      path: [],
      title: [],
      hostname: [],
    },
  };
}
function emptyOverviewPageSectionCards(): OverviewPagesSectionCardData {
  return {
    page: {
      path: [],
      query: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    },
    source: {
      domain: [],
      link: [],
    },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}
function buildEventCardDataOverride(
  rows: EventsSummaryData["cards"]["event"]["name"],
): OverviewPagesSectionCardData {
  const emptyCards = emptyOverviewPageSectionCards();
  return {
    ...emptyCards,
    page: {
      ...emptyCards.page,
      path: rows,
    },
  };
}
function buildContextCardDataOverride(
  page: EventsSummaryData["cards"]["page"],
): OverviewPagesSectionCardData {
  const emptyCards = emptyOverviewPageSectionCards();
  return {
    ...emptyCards,
    page: {
      ...emptyCards.page,
      path: page.path,
      title: page.title,
      hostname: page.hostname,
    },
  };
}
function emptyTrend(interval: TimeWindow["interval"]): EventsTrendData {
  return {
    ok: true,
    interval,
    series: [],
    data: [],
  };
}
function detailQueryTarget(
  pathname: string,
  searchParams: URLSearchParams,
  detailId: string,
): string | null {
  const normalized = detailId.trim();
  if (!normalized) return null;

  const params = new URLSearchParams(searchParams.toString());
  params.set(DETAIL_QUERY_PARAM, normalized);
  params.delete("eventName");
  const query = serializeDashboardSearchParams(params);
  return query ? `${pathname}?${query}` : pathname;
}
function comparisonLabelForEvents(
  messages: AppMessages,
  mode: "same" | "previous" | undefined,
  hasComparisonFilter: boolean,
): string {
  return mode === "previous" && !hasComparisonFilter
    ? messages.dashboardHeader.previousPeriod
    : messages.dashboardHeader.compareButton;
}
export function EventsClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
}: EventsClientPageProps) {
  const labels = messages.events;
  const searchParams = useLiveSearchParams();
  const detailEventName = searchParams.get(DETAIL_QUERY_PARAM)?.trim() || "";
  const openedDetailFromListRef = useRef(false);
  const { window: timeWindow } = useDashboardQuery() as {
    window: TimeWindow;
  };
  const searchParamsKey = searchParams.toString();
  const filters = useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonQuery = useMemo(
    () =>
      resolveDashboardComparisonQuery(
        new URLSearchParams(searchParamsKey),
        timeWindow,
        filters,
      ),
    [
      filters,
      searchParamsKey,
      timeWindow.from,
      timeWindow.interval,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );

  useEffect(() => {
    if (!detailEventName) {
      openedDetailFromListRef.current = false;
    }
  }, [detailEventName]);

  const { data, isFetching, isPending } = useQuery({
    queryKey: [
      "dashboard",
      "events-overview",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? "none",
      comparisonQuery?.window.to ?? "none",
      comparisonQuery?.window.interval ?? "none",
      comparisonQuery?.window.timeZone ?? "none",
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const currentRequest = Promise.all([
        fetchEventsSummary(siteId, timeWindow, filters, { signal }),
        fetchEventsTrend(siteId, timeWindow, filters, {
          limit: EVENT_TREND_MAX_SERIES,
          signal,
        }),
      ]);
      if (!comparisonQuery) {
        const [summary, trend] = await currentRequest;
        return { summary, trend };
      }

      const comparisonRequest = Promise.all([
        fetchEventsSummary(
          siteId,
          comparisonQuery.window,
          comparisonQuery.filters,
          { signal },
        ),
        fetchEventsTrend(
          siteId,
          comparisonQuery.window,
          comparisonQuery.filters,
          {
            limit: EVENT_TREND_MAX_SERIES,
            signal,
          },
        ),
      ]);
      const [[summary, trend], [comparisonSummary, comparisonTrend]] =
        await Promise.all([currentRequest, comparisonRequest]);
      return { summary, trend, comparisonSummary, comparisonTrend };
    },
    enabled: typeof window !== "undefined",
  });
  const loading = isPending || isFetching;
  const summary = data?.summary ?? emptySummary();
  const trend = data?.trend ?? emptyTrend(timeWindow.interval);
  const comparisonLabel = comparisonLabelForEvents(
    messages,
    comparisonQuery?.mode,
    Boolean(comparisonQuery?.filters.root),
  );
  const initialLoading = isPending && !data;

  const openEventType = useCallback(
    (eventName: string) => {
      const target = detailQueryTarget(pathname, searchParams, eventName);
      if (!target) return;
      openedDetailFromListRef.current = true;
      pushUrlWithoutNavigation(target);
    },
    [pathname, searchParams],
  );
  const closeEventType = useCallback(() => {
    const params = new URLSearchParams(globalThis.window.location.search);
    if (!params.has(DETAIL_QUERY_PARAM)) return;

    if (openedDetailFromListRef.current) {
      openedDetailFromListRef.current = false;
      globalThis.window.history.back();
      return;
    }

    params.delete(DETAIL_QUERY_PARAM);
    params.delete("eventName");
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);
  const siteBasePath = useMemo(
    () => pathname.replace(/\/events$/, ""),
    [pathname],
  );
  const eventCardDataOverride = useMemo<OverviewPagesSectionCardData>(
    () => buildEventCardDataOverride(summary.cards.event.name),
    [summary.cards.event.name],
  );
  const contextCardDataOverride = useMemo<OverviewPagesSectionCardData>(
    () => buildContextCardDataOverride(summary.cards.page),
    [summary.cards.page],
  );

  return (
    <div className="space-y-6">
      <EventPageHeader
        messages={messages}
        title={messages.events.title}
        subtitle={messages.events.subtitle}
      />

      <EventMetricGrid
        locale={locale}
        labels={labels}
        summary={summary.summary}
        comparisonSummary={data?.comparisonSummary?.summary}
        comparisonLabel={comparisonLabel}
        loading={loading}
      />

      <EventTrendStackedBarCard
        locale={locale}
        labels={labels}
        trend={trend}
        comparisonTrend={data?.comparisonTrend}
        comparisonWindow={comparisonQuery?.window}
        window={timeWindow}
        title={labels.trendTitle}
        loading={loading}
        cumulativeLabel={messages.common.cumulativeEvents}
        currentPeriodLabel={messages.dashboardHeader.compareCurrentPeriod}
        comparisonLabel={comparisonLabel}
        onSelectEvent={openEventType}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <OverviewPagesSection
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={pathname}
          filters={filters}
          loading={initialLoading}
          cardDataOverride={eventCardDataOverride}
          visibleCards={["page"]}
          pageCardTabs={["path"]}
          pageCardTabMetaOverride={{
            path: {
              label: labels.topEvents,
              columnLabel: labels.eventName,
              primaryMetricLabel: labels.totalEvents,
              mono: false,
              showIcon: false,
            },
          }}
          pageCardFilterEnabledOverride={{ path: false }}
          pageCardNavigableTabs={[]}
          pageCardDetailTabs={["path"]}
          pageCardDetailClickResolvers={{
            path: ({ value }) => openEventType(value),
          }}
          pageCardShowVisitors
          primaryMetricLabel={labels.totalEvents}
          sectionClassName="xl:grid-cols-1"
        />

        <OverviewPagesSection
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={siteBasePath}
          filters={filters}
          loading={initialLoading}
          cardDataOverride={contextCardDataOverride}
          visibleCards={["page"]}
          pageCardTabs={["path", "title", "hostname"]}
          primaryMetricLabel={labels.totalEvents}
          sectionClassName="xl:grid-cols-1"
        />
      </div>

      <EventRecordsSection
        locale={locale}
        messages={messages}
        labels={labels}
        siteId={siteId}
        pathname={pathname}
        window={timeWindow}
        filters={filters}
      />

      {detailEventName ? (
        <DetailModal
          ariaLabel={messages.events.detailTitle}
          modalKey={`event:${detailEventName}`}
          onClose={closeEventType}
        >
          <EventTypeDetailClientPage
            locale={locale}
            messages={messages}
            siteId={siteId}
            siteDomain={siteDomain}
            pathname={pathname}
            eventName={detailEventName}
          />
        </DetailModal>
      ) : null}
    </div>
  );
}
