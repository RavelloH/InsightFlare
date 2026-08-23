import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { EVENT_TREND_MAX_SERIES } from "@/components/dashboard/charts/event-trend-bar-chart";
import {
  DETAIL_QUERY_PARAM,
  DetailModal,
  useDetailModalReady,
} from "@/components/dashboard/site-pages/detail-query-modal";
import {
  EventMetricGrid,
  EventPageHeader,
  EventRecordsSection,
  EventTrendStackedBarCard,
} from "@/components/dashboard/site-pages/event-analytics-components";
import { EventTypeDetailLoadingState } from "@/components/dashboard/site-pages/event-type-detail-loading-state";
import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
  parseOverviewCardFilters,
} from "@/components/dashboard/site-pages/overview-client-page";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  fetchEventsSummary,
  fetchEventsTrend,
} from "@/lib/dashboard/client-data";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type { EventsSummaryData, EventsTrendData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface EventsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
}

const EventTypeDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/event-type-detail-client-page").then(
      (module) => module.EventTypeDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => <EventTypeDetailModalLoadingState />,
  },
);

function EventTypeDetailModalLoadingState({
  loadingLabel,
}: {
  loadingLabel?: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      <EventTypeDetailLoadingState loadingLabel={loadingLabel} />
    </div>
  );
}

function EventTypeDetailModalContent(props: {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  eventName: string;
}) {
  const modalReady = useDetailModalReady();
  const [renderEventName, setRenderEventName] = useState("");

  useEffect(() => {
    if (!modalReady) {
      setRenderEventName("");
      return;
    }

    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setRenderEventName(props.eventName);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [modalReady, props.eventName]);

  if (!modalReady || renderEventName !== props.eventName) {
    return (
      <EventTypeDetailModalLoadingState
        loadingLabel={props.messages.common.loading}
      />
    );
  }

  return <EventTypeDetailClientPage key={props.eventName} {...props} />;
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
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  useEffect(() => {
    if (!detailEventName) {
      openedDetailFromListRef.current = false;
    }
  }, [detailEventName]);

  const {
    data,
    isFetching: loading,
    isPending,
  } = useQuery({
    queryKey: [
      "dashboard",
      "events-overview",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const [summary, trend] = await Promise.all([
        fetchEventsSummary(siteId, timeWindow, filters, { signal }),
        fetchEventsTrend(siteId, timeWindow, filters, {
          limit: EVENT_TREND_MAX_SERIES,
          signal,
        }),
      ]);
      return { summary, trend };
    },
    enabled: typeof window !== "undefined",
  });
  const summary = data?.summary ?? emptySummary();
  const trend = data?.trend ?? emptyTrend(timeWindow.interval);
  const initialLoading = isPending && !data;

  const openEventType = useCallback(
    (eventName: string) => {
      const target = detailQueryTarget(pathname, searchParams, eventName);
      if (!target) return;
      openedDetailFromListRef.current = true;
      void import("@/components/dashboard/site-pages/event-type-detail-client-page");
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
        loading={loading}
      />

      <EventTrendStackedBarCard
        locale={locale}
        labels={labels}
        trend={trend}
        window={timeWindow}
        title={labels.trendTitle}
        loading={loading}
        cumulativeLabel={messages.common.cumulativeEvents}
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
          <EventTypeDetailModalContent
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
