import { useCallback, useEffect, useMemo, useRef } from "react";
import { DetailModal } from "@insightflare/product-ui/detail-drawer";
import { MetricSummaryGrid } from "@insightflare/ui/metric-summary-grid";
import { useQuery } from "@tanstack/react-query";

import { useDashboardQueryReady } from "@/components/dashboard/shell/dashboard-query-provider";
import { DETAIL_QUERY_PARAM } from "@/components/dashboard/site-pages/common/detail-query-param";
import { useDashboardTimeWindow } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { EventTypeDetailClientPage } from "@/components/dashboard/site-pages/events/event-type-detail-client-page";
import {
  createEventMetricItems,
  EventTrendStackedBarCard,
} from "@/components/dashboard/site-pages/events/metrics-components";
import { EventPageHeader } from "@/components/dashboard/site-pages/events/page-header";
import { EventRecordsSection } from "@/components/dashboard/site-pages/events/records-section";
import { parseOverviewCardFilters } from "@/components/dashboard/site-pages/overview/overview-filter-model";
import { OverviewPagesSection } from "@/components/dashboard/site-pages/overview/pages-section";
import { type OverviewPagesSectionCardData } from "@/components/dashboard/site-pages/overview/types";
import { EVENT_INITIAL_TREND_LIMIT } from "@/lib/dashboard/client/data/events";
import {
  fetchEventsSummary,
  fetchEventsTrend,
} from "@/lib/dashboard/client/data/index";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import {
  createDeferredPrivateReadTransport,
  type DeferredPrivateReads,
} from "@/lib/dashboard/client/request";
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
import {
  capturePerceptionGuard,
  observeLoadedDimension,
} from "@/lib/perception-search/runtime";
interface EventsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  deferredReads?: DeferredPrivateReads | null;
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
const EMPTY_SUMMARY = emptySummary();
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
  deferredReads,
}: EventsClientPageProps) {
  const queryReady = useDashboardQueryReady();
  const transport = useMemo(
    () =>
      deferredReads
        ? createDeferredPrivateReadTransport(deferredReads)
        : undefined,
    [deferredReads],
  );
  const labels = messages.events;
  const searchParams = useLiveSearchParams();
  const detailEventName = searchParams.get(DETAIL_QUERY_PARAM)?.trim() || "";
  const openedDetailFromListRef = useRef(false);
  const timeWindow = useDashboardTimeWindow();
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

  const baseKey = [
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
  ];
  const summaryQuery = useQuery({
    queryKey: ["dashboard", "events-summary", ...baseKey],
    queryFn: async ({ signal }) => {
      const observationGuard = capturePerceptionGuard(siteId);
      const options = { signal, ...(transport ? { transport } : {}) };
      const [summary, comparisonSummary] = await Promise.all([
        fetchEventsSummary(siteId, timeWindow, filters, options).then(
          (summary) => {
            if (!signal.aborted)
              observeLoadedDimension(
                siteId,
                "event.name",
                summary.cards.event.name.map((row) => row.label),
                observationGuard,
              );
            return summary;
          },
        ),
        comparisonQuery
          ? fetchEventsSummary(
              siteId,
              comparisonQuery.window,
              comparisonQuery.filters,
              options,
            )
          : Promise.resolve(undefined),
      ]);
      return { summary, comparisonSummary };
    },
    enabled: queryReady,
  });
  const trendQuery = useQuery({
    queryKey: ["dashboard", "events-trend", ...baseKey],
    queryFn: async ({ signal }) => {
      const options = {
        limit: EVENT_INITIAL_TREND_LIMIT,
        signal,
        ...(transport ? { transport } : {}),
      };
      const [trend, comparisonTrend] = await Promise.all([
        fetchEventsTrend(siteId, timeWindow, filters, options),
        comparisonQuery
          ? fetchEventsTrend(
              siteId,
              comparisonQuery.window,
              comparisonQuery.filters,
              options,
            )
          : Promise.resolve(undefined),
      ]);
      return { trend, comparisonTrend };
    },
    enabled: queryReady,
  });
  const summary = summaryQuery.data?.summary ?? EMPTY_SUMMARY;
  const trend = trendQuery.data?.trend ?? emptyTrend(timeWindow.interval);
  const comparisonLabel = comparisonLabelForEvents(
    messages,
    comparisonQuery?.mode,
    Boolean(comparisonQuery?.filters.root),
  );
  const initialLoading = summaryQuery.isPending && !summaryQuery.data;

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

      <MetricSummaryGrid
        items={createEventMetricItems({
          locale,
          labels,
          summary: summary.summary,
          comparisonSummary: summaryQuery.data?.comparisonSummary?.summary,
          comparisonLabel,
          loading: summaryQuery.isPending || summaryQuery.isFetching,
        })}
      />

      <EventTrendStackedBarCard
        locale={locale}
        labels={labels}
        trend={trend}
        comparisonTrend={trendQuery.data?.comparisonTrend}
        comparisonWindow={comparisonQuery?.window}
        window={timeWindow}
        title={labels.trendTitle}
        loading={trendQuery.isPending || trendQuery.isFetching}
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
          queryEnabled={
            queryReady && (Boolean(comparisonQuery) || !initialLoading)
          }
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
          queryEnabled={
            queryReady && (Boolean(comparisonQuery) || !initialLoading)
          }
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
        transport={transport}
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
