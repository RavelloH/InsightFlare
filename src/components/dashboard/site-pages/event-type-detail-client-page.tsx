import { memo, useMemo } from "react";
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
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventTypeDetailData } from "@/lib/edge-client";
import type { FilterDocument, FilterScope } from "@/lib/filter-contract";
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

type EventTypeContextFetcherOptions = {
  comparison?: {
    mode: "same" | "previous";
    window: TimeWindow;
    filters: FilterDocument;
  } | null;
  signal?: AbortSignal;
};

function eventContextRowKey(row: OverviewTabRows[number]): string {
  const canonicalValue = row.value?.trim();
  return row.key?.trim() || canonicalValue || String(row.label ?? "").trim();
}

function eventContextRowMetricValue(
  row: OverviewTabRows[number] | undefined,
  metric: "views" | "sessions" | "visitors",
): number {
  return Math.max(0, Number(row?.[metric] ?? 0));
}

function mergeEventTypeContextRows(
  currentRows: OverviewTabRows,
  comparisonRows: OverviewTabRows,
): OverviewTabRows {
  const currentByKey = new Map(
    currentRows.map((row) => [eventContextRowKey(row), row]),
  );
  const comparisonByKey = new Map(
    comparisonRows.map((row) => [eventContextRowKey(row), row]),
  );
  const keys = [
    ...currentRows.map(eventContextRowKey),
    ...comparisonRows
      .map(eventContextRowKey)
      .filter((key) => !currentByKey.has(key)),
  ];

  return keys.map((key) => {
    const current = currentByKey.get(key);
    const comparison = comparisonByKey.get(key);
    const row = current ??
      comparison ?? {
        label: key,
        views: 0,
        sessions: 0,
        visitors: 0,
      };
    const views = eventContextRowMetricValue(current, "views");
    const sessions = eventContextRowMetricValue(current, "sessions");
    const visitors = eventContextRowMetricValue(current, "visitors");
    const referenceViews = eventContextRowMetricValue(comparison, "views");
    const referenceSessions = eventContextRowMetricValue(
      comparison,
      "sessions",
    );
    const referenceVisitors = eventContextRowMetricValue(
      comparison,
      "visitors",
    );
    const relativeChange = (value: number, reference: number) =>
      reference === 0 ? null : (value - reference) / reference;

    return {
      ...row,
      key,
      label: row.label ?? key,
      views,
      sessions,
      visitors,
      reference: {
        views: referenceViews,
        sessions: referenceSessions,
        visitors: referenceVisitors,
      },
      change: {
        views: {
          absolute: views - referenceViews,
          relative: relativeChange(views, referenceViews),
        },
        sessions: {
          absolute: sessions - referenceSessions,
          relative: relativeChange(sessions, referenceSessions),
        },
        visitors: {
          absolute: visitors - referenceVisitors,
          relative: relativeChange(visitors, referenceVisitors),
        },
      },
    };
  });
}

function createEventTypeContextFetcher(
  eventName: string,
  cardKey: string,
  select: (cards: EventTypeDetailData["cards"]) => OverviewTabRows,
) {
  return async (
    siteId: string,
    window: TimeWindow,
    filters: FilterDocument,
    _resolvedScope?: FilterScope,
    options?: EventTypeContextFetcherOptions,
  ): Promise<OverviewTabRows> => {
    const currentRequest = fetchEventTypeContextCards(
      siteId,
      window,
      eventName,
      cardKey,
      filters,
    );
    const comparison = options?.comparison;
    if (!comparison) return select(await currentRequest);

    const [currentCards, comparisonCards] = await Promise.all([
      currentRequest,
      fetchEventTypeContextCards(
        siteId,
        comparison.window,
        eventName,
        cardKey,
        comparison.filters,
      ),
    ]);

    return mergeEventTypeContextRows(
      select(currentCards),
      select(comparisonCards),
    );
  };
}

function comparisonLabelForEventDetail(
  messages: AppMessages,
  mode: "same" | "previous" | undefined,
  hasComparisonFilter: boolean,
): string {
  return mode === "previous" && !hasComparisonFilter
    ? messages.dashboardHeader.previousPeriod
    : messages.dashboardHeader.compareButton;
}

export const EventTypeDetailClientPage = memo(
  function EventTypeDetailClientPage({
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
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const comparisonQuery = useMemo(
      () =>
        resolveDashboardComparisonQuery(
          new URLSearchParams(liveSearchParamsKey),
          window,
          filters,
        ),
      [
        filters,
        liveSearchParamsKey,
        window.from,
        window.interval,
        window.timeZone,
        window.to,
      ],
    );
    const comparisonFiltersKey = useMemo(
      () =>
        comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none",
      [comparisonQuery],
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
          comparisonQuery?.mode ?? "none",
          comparisonQuery?.window.from ?? "none",
          comparisonQuery?.window.to ?? "none",
          comparisonQuery?.window.interval ?? "none",
          comparisonQuery?.window.timeZone ?? "none",
          comparisonFiltersKey,
        ].join(":"),
      [
        eventName,
        filtersKey,
        requestWindow.from,
        requestWindow.interval,
        requestWindow.timeZone,
        requestWindow.to,
        siteId,
        comparisonFiltersKey,
        comparisonQuery?.mode,
        comparisonQuery?.window.from,
        comparisonQuery?.window.interval,
        comparisonQuery?.window.timeZone,
        comparisonQuery?.window.to,
      ],
    );
    const {
      data,
      isError: error,
      isFetching: loading,
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
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        comparisonQuery?.window.interval ?? "none",
        comparisonQuery?.window.timeZone ?? "none",
        comparisonFiltersKey,
      ],
      queryFn: async ({ signal }) => {
        const currentRequest = fetchEventTypeDetail(
          siteId,
          requestWindow,
          eventName,
          requestFilters,
          { signal },
        );
        if (!comparisonQuery) {
          return { current: await currentRequest };
        }

        const [current, comparison] = await Promise.all([
          currentRequest,
          fetchEventTypeDetail(
            siteId,
            comparisonQuery.window,
            eventName,
            comparisonQuery.filters,
            { signal },
          ),
        ]);
        return { current, comparison };
      },
      enabled: typeof window !== "undefined" && Boolean(eventName),
    });
    const detail = data?.current ?? emptyEventTypeDetail(eventName);
    const comparisonDetail = data?.comparison;
    const comparisonLabel = comparisonLabelForEventDetail(
      messages,
      comparisonQuery?.mode,
      Boolean(comparisonQuery?.filters.root),
    );
    const trendData = useMemo(
      () =>
        detail.trend.data.map((point) => ({
          timestampMs: point.timestampMs,
          views: Math.max(0, Number(point.events ?? 0)),
          visitors: Math.max(0, Number(point.visitors ?? 0)),
        })),
      [detail.trend.data],
    );
    const comparisonTrendData = useMemo(
      () =>
        comparisonDetail?.trend.data.map((point) => ({
          timestampMs: point.timestampMs,
          views: Math.max(0, Number(point.events ?? 0)),
          visitors: Math.max(0, Number(point.visitors ?? 0)),
        })),
      [comparisonDetail?.trend.data],
    );
    const contextCardFetchers = useMemo(
      () => ({
        pageCardFetchers: {
          path: createEventTypeContextFetcher(
            eventName,
            "path",
            (cards) => cards.page.path,
          ),
          query: createEventTypeContextFetcher(
            eventName,
            "query",
            (cards) => cards.page.query,
          ),
          title: createEventTypeContextFetcher(
            eventName,
            "title",
            (cards) => cards.page.title,
          ),
          hostname: createEventTypeContextFetcher(
            eventName,
            "hostname",
            (cards) => cards.page.hostname,
          ),
          entry: createEventTypeContextFetcher(
            eventName,
            "entry",
            (cards) => cards.page.entry,
          ),
          exit: createEventTypeContextFetcher(
            eventName,
            "exit",
            (cards) => cards.page.exit,
          ),
        },
        sourceCardFetchers: {
          domain: createEventTypeContextFetcher(
            eventName,
            "sourceDomain",
            (cards) => cards.source.domain,
          ),
          link: createEventTypeContextFetcher(
            eventName,
            "sourceLink",
            (cards) => cards.source.link,
          ),
        },
        clientCardFetchers: {
          browser: createEventTypeContextFetcher(
            eventName,
            "browser",
            (cards) => cards.client.browser,
          ),
          osVersion: createEventTypeContextFetcher(
            eventName,
            "osVersion",
            (cards) => cards.client.osVersion,
          ),
          deviceType: createEventTypeContextFetcher(
            eventName,
            "deviceType",
            (cards) => cards.client.deviceType,
          ),
          language: createEventTypeContextFetcher(
            eventName,
            "language",
            (cards) => cards.client.language,
          ),
          screenSize: createEventTypeContextFetcher(
            eventName,
            "screenSize",
            (cards) => cards.client.screenSize,
          ),
        },
        geoCardFetchers: {
          country: createEventTypeContextFetcher(
            eventName,
            "country",
            (cards) => cards.geo.country,
          ),
          region: createEventTypeContextFetcher(
            eventName,
            "region",
            (cards) => cards.geo.region,
          ),
          city: createEventTypeContextFetcher(
            eventName,
            "city",
            (cards) => cards.geo.city,
          ),
          continent: createEventTypeContextFetcher(
            eventName,
            "continent",
            (cards) => cards.geo.continent,
          ),
          timezone: createEventTypeContextFetcher(
            eventName,
            "timezone",
            (cards) => cards.geo.timezone,
          ),
          organization: createEventTypeContextFetcher(
            eventName,
            "organization",
            (cards) => cards.geo.organization,
          ),
        },
      }),
      [eventName],
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
            comparisonSummary={comparisonDetail?.summary}
            comparisonLabel={comparisonLabel}
            includeShare
            loading={loading}
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
                axisDateFormat="regular"
                showLegend
                loading={loading}
                comparisonData={comparisonTrendData}
                comparisonRange={
                  comparisonQuery
                    ? {
                        from: comparisonQuery.window.from,
                        to: comparisonQuery.window.to,
                      }
                    : undefined
                }
                currentPeriodLabel={
                  messages.dashboardHeader.compareCurrentPeriod
                }
                comparisonLabel={comparisonLabel}
                className="h-[280px]"
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
            loading={loading}
            {...contextCardFetchers}
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
      </div>
    );
  },
);
