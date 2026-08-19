import { useMemo } from "react";
import { RiPulseLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { JourneyDetailStateSwitch } from "@/components/dashboard/journey-detail-state";
import { useDetailModalClose } from "@/components/dashboard/site-pages/detail-query-modal";
import {
  EventFieldsCard,
  EventMetricGrid,
  EventPageHeader,
  EventRecordsSection,
} from "@/components/dashboard/site-pages/event-analytics-components";
import { EventTypeDetailLoadingState } from "@/components/dashboard/site-pages/event-type-detail-loading-state";
import {
  OverviewPagesSection,
  parseOverviewCardFilters,
} from "@/components/dashboard/site-pages/overview-client-page";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveSearchParams } from "@/lib/client-history";
import {
  fetchEventTypeContextCards,
  fetchEventTypeDetail,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventTypeDetailData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface EventTypeDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  eventName: string;
}

function emptyEventTypeDetail(eventName: string): EventTypeDetailData {
  return {
    ok: true,
    eventName,
    summary: {
      events: 0,
      eventTypes: eventName ? 1 : 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
      shareOfAllEvents: 0,
    },
    trend: {
      data: [],
    },
    breakdowns: {
      pages: [],
      countries: [],
      devices: [],
      browsers: [],
    },
    cards: emptyDetailCards(),
    fields: [],
  };
}

function emptyDetailCards(): EventTypeDetailData["cards"] {
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

export function EventTypeDetailClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  eventName,
}: EventTypeDetailClientPageProps) {
  const modalClose = useDetailModalClose();
  const liveSearchParams = useLiveSearchParams();
  const labels = messages.events;
  const { window } = useDashboardQuery() as {
    window: TimeWindow;
  };
  const eventsPath = pathname.replace(/\/detail$/, "");
  const siteBasePath = eventsPath.replace(/\/events$/, "");
  const liveSearchParamsKey = liveSearchParams.toString();
  const filters = useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(liveSearchParamsKey)),
    [liveSearchParamsKey],
  );
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
  const requestKey = useMemo(
    () =>
      [
        siteId,
        eventName,
        requestWindow.from,
        requestWindow.to,
        requestWindow.interval,
        requestWindow.timeZone,
        filtersKey,
      ].join(":"),
    [
      eventName,
      filtersKey,
      requestWindow.from,
      requestWindow.interval,
      requestWindow.timeZone,
      requestWindow.to,
      siteId,
    ],
  );
  const {
    data,
    isError: error,
    isFetching: loading,
    isPending,
  } = useQuery({
    queryKey: [
      "dashboard",
      "event-type-detail",
      siteId,
      eventName,
      requestWindow.from,
      requestWindow.to,
      requestWindow.interval,
      requestWindow.timeZone,
      filtersKey,
    ],
    queryFn: ({ signal }) =>
      fetchEventTypeDetail(siteId, requestWindow, eventName, requestFilters, {
        signal,
      }),
    enabled: typeof window !== "undefined" && Boolean(eventName),
  });
  const detail = data ?? emptyEventTypeDetail(eventName);
  const initialLoading = isPending && detail.summary.events === 0;
  const detailStateKey = initialLoading
    ? "event-type-loading"
    : `event-type-content-${requestKey}-${error ? "error" : "ready"}`;
  const trendData = useMemo(
    () =>
      detail.trend.data.map((point) => ({
        timestampMs: point.timestampMs,
        views: Math.max(0, Number(point.events ?? 0)),
        visitors: Math.max(0, Number(point.visitors ?? 0)),
      })),
    [detail.trend.data],
  );

  if (!eventName) {
    return (
      <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
        <EventPageHeader
          messages={messages}
          title={messages.events.detailTitle}
          subtitle={messages.events.typeDetailSubtitle}
          backHref={eventsPath}
          backLabel={messages.events.backToEvents}
          onBack={modalClose ?? undefined}
        />
        <JourneyDetailStateSwitch stateKey="event-type-missing">
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              {messages.events.noEventName}
            </CardContent>
          </Card>
        </JourneyDetailStateSwitch>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      <EventPageHeader
        messages={messages}
        title={eventName}
        subtitle={messages.events.typeDetailSubtitle}
        backHref={eventsPath}
        backLabel={messages.events.backToEvents}
        onBack={modalClose ?? undefined}
      />

      <JourneyDetailStateSwitch stateKey={detailStateKey}>
        {initialLoading ? (
          <EventTypeDetailLoadingState loadingLabel={messages.common.loading} />
        ) : (
          <div className="space-y-6">
            {error ? (
              <Card>
                <CardContent className="py-4 text-sm text-muted-foreground">
                  {messages.events.loadError}
                </CardContent>
              </Card>
            ) : null}

            <EventMetricGrid
              locale={locale}
              labels={labels}
              summary={detail.summary}
              includeShare
            />

            <Card className="overflow-visible">
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-2">
                  <RiPulseLine className="size-4" />
                  {messages.events.trendTitle}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TrafficPairBarChart
                  data={trendData}
                  locale={locale}
                  timeZone={requestWindow.timeZone}
                  interval={requestWindow.interval}
                  range={{
                    from: requestWindow.from,
                    to: requestWindow.to,
                  }}
                  viewsLabel={labels.triggerCount}
                  visitorsLabel={labels.triggerVisitors}
                  className="h-[320px]"
                />
              </CardContent>
            </Card>

            <OverviewPagesSection
              key={requestKey}
              locale={locale}
              messages={messages}
              siteId={siteId}
              siteDomain={siteDomain}
              pathname={siteBasePath}
              filters={requestFilters}
              loading={initialLoading}
              pageCardFetchers={{
                path: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "path",
                    requestedFilters,
                  ).then((cards) => cards.page.path),
                query: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "query",
                    requestedFilters,
                  ).then((cards) => cards.page.query),
                title: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "title",
                    requestedFilters,
                  ).then((cards) => cards.page.title),
                hostname: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "hostname",
                    requestedFilters,
                  ).then((cards) => cards.page.hostname),
                entry: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "entry",
                    requestedFilters,
                  ).then((cards) => cards.page.entry),
                exit: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "exit",
                    requestedFilters,
                  ).then((cards) => cards.page.exit),
              }}
              sourceCardFetchers={{
                domain: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "sourceDomain",
                    requestedFilters,
                  ).then((cards) => cards.source.domain),
                link: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "sourceLink",
                    requestedFilters,
                  ).then((cards) => cards.source.link),
              }}
              clientCardFetchers={{
                browser: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "browser",
                    requestedFilters,
                  ).then((cards) => cards.client.browser),
                osVersion: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "osVersion",
                    requestedFilters,
                  ).then((cards) => cards.client.osVersion),
                deviceType: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "deviceType",
                    requestedFilters,
                  ).then((cards) => cards.client.deviceType),
                language: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "language",
                    requestedFilters,
                  ).then((cards) => cards.client.language),
                screenSize: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "screenSize",
                    requestedFilters,
                  ).then((cards) => cards.client.screenSize),
              }}
              geoCardFetchers={{
                country: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "country",
                    requestedFilters,
                  ).then((cards) => cards.geo.country),
                region: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "region",
                    requestedFilters,
                  ).then((cards) => cards.geo.region),
                city: (requestedSiteId, requestedWindow, requestedFilters) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "city",
                    requestedFilters,
                  ).then((cards) => cards.geo.city),
                continent: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "continent",
                    requestedFilters,
                  ).then((cards) => cards.geo.continent),
                timezone: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "timezone",
                    requestedFilters,
                  ).then((cards) => cards.geo.timezone),
                organization: (
                  requestedSiteId,
                  requestedWindow,
                  requestedFilters,
                ) =>
                  fetchEventTypeContextCards(
                    requestedSiteId,
                    requestedWindow,
                    eventName,
                    "organization",
                    requestedFilters,
                  ).then((cards) => cards.geo.organization),
              }}
              primaryMetricLabel={labels.totalEvents}
              geoPageBasePathname={siteBasePath}
            />

            <EventFieldsCard
              locale={locale}
              labels={labels}
              siteId={siteId}
              window={requestWindow}
              filters={requestFilters}
              eventName={eventName}
              loading={loading}
              fields={detail.fields}
            />

            <EventRecordsSection
              locale={locale}
              messages={messages}
              labels={labels}
              siteId={siteId}
              pathname={eventsPath}
              window={requestWindow}
              filters={requestFilters}
              eventName={eventName}
            />
          </div>
        )}
      </JourneyDetailStateSwitch>
    </div>
  );
}
