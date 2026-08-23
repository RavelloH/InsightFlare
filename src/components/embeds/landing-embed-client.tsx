import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { BrowserCrossBreakdownGrid } from "@/components/dashboard/browser-cross-breakdown-grid";
import { BrowserEngineShareTrendCard } from "@/components/dashboard/browser-engine-share-trend-card";
import { BrowserPerformanceRadarCard } from "@/components/dashboard/browser-performance-radar-card";
import { BrowserShareOverview } from "@/components/dashboard/browser-share-overview";
import { BrowserShareTrendCard } from "@/components/dashboard/browser-share-trend-card";
import { BrowserVersionBreakdownGrid } from "@/components/dashboard/browser-version-breakdown-grid";
import { CanIUseCompatCard } from "@/components/dashboard/caniuse-compat-card";
import { EVENT_TREND_MAX_SERIES } from "@/components/dashboard/charts/event-trend-bar-chart";
import {
  DashboardQueryProvider,
  useDashboardQuery,
} from "@/components/dashboard/dashboard-query-provider";
import { DeviceCrossBreakdownGrid } from "@/components/dashboard/device-cross-breakdown-grid";
import { DeviceDimensionTrendCard } from "@/components/dashboard/device-dimension-trend-card";
import { DeviceScreenBreakdownCard } from "@/components/dashboard/device-screen-breakdown-card";
import { DeviceShareOverview } from "@/components/dashboard/device-share-overview";
import { OverviewGeoPointsMapCard } from "@/components/dashboard/overview-geo-points-map-card";
import { RealtimeLogStreamCard } from "@/components/dashboard/realtime-log-stream-card";
import { RealtimeTrafficTrendCard } from "@/components/dashboard/realtime-traffic-trend-card";
import {
  EventMetricGrid,
  EventRecordsSection,
  EventTrendStackedBarCard,
} from "@/components/dashboard/site-pages/event-analytics-components";
import {
  OverviewMetricsSection,
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
  OverviewTrendSection,
  parseOverviewCardFilters,
} from "@/components/dashboard/site-pages/overview-client-page";
import {
  parseRealtimeCardFilters,
  RealtimeSummaryCardsSection,
} from "@/components/dashboard/site-pages/realtime-summary-cards-section";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeChannelSelector } from "@/hooks/use-realtime-channel";
import { useLiveSearchParams } from "@/lib/client-history";
import {
  fetchEventsSummary,
  fetchEventsTrend,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type { EventsSummaryData, EventsTrendData } from "@/lib/edge-client";
import {
  buildLandingEmbedDemoSitePath,
  LANDING_EMBED_DEMO_SITE,
  type LandingEmbedView,
  normalizeLandingEmbedView,
} from "@/lib/embeds/landing";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

interface LandingEmbedClientProps {
  locale: Locale;
  messages: AppMessages;
  view: LandingEmbedView;
}

interface BaseDashboardPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}

interface PathDashboardPageProps extends BaseDashboardPageProps {
  pathname: string;
}

const RetentionEmbed = dynamic<PathDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/retention-client-page").then(
      (module) => module.RetentionClientPage,
    ),
  { loading: LandingEmbedLoading },
);

const PagesEmbed = dynamic<PathDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/pages-client-page").then(
      (module) => module.PagesClientPage,
    ),
  { loading: LandingEmbedLoading },
);

const PerformanceEmbed = dynamic<BaseDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/performance-client-page").then(
      (module) => module.PerformanceClientPage,
    ),
  { loading: LandingEmbedLoading },
);

const SessionsEmbed = dynamic<PathDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/sessions-client-page").then(
      (module) => module.SessionsClientPage,
    ),
  { loading: LandingEmbedLoading },
);

const VisitorsEmbed = dynamic<PathDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/visitors-client-page").then(
      (module) => module.VisitorsClientPage,
    ),
  { loading: LandingEmbedLoading },
);

const FunnelsEmbed = dynamic<PathDashboardPageProps>(
  () =>
    import("@/components/dashboard/site-pages/funnels-client-page").then(
      (module) => module.FunnelsClientPage,
    ),
  { loading: LandingEmbedLoading },
);

function LandingEmbedLoading() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-48 w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

function useOverviewEmbedFilters(): FilterDocument {
  const searchParams = useLiveSearchParams();
  const searchParamsKey = searchParams.toString();
  return useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
}

function useRealtimeEmbedFilters(): FilterDocument {
  const searchParams = useLiveSearchParams();
  const searchParamsKey = searchParams.toString();
  return useMemo(
    () => parseRealtimeCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
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

function emptyEventsSummary(): EventsSummaryData {
  return {
    ok: true,
    summary: {
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
    },
    cards: {
      event: {
        name: [],
      },
      page: {
        path: [],
        title: [],
        hostname: [],
      },
    },
  };
}

function emptyEventsTrend(interval: TimeWindow["interval"]): EventsTrendData {
  return {
    ok: true,
    interval,
    series: [],
    data: [],
  };
}

function OverviewEmbedBlock({
  locale,
  messages,
  pathname,
  siteDomain,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  siteDomain: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  const { window } = useDashboardQuery();
  const filters = useOverviewEmbedFilters();

  if (view === "traffic-trend") {
    return (
      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  if (view === "traffic-pages") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={filters}
        visibleCards={["page"]}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "traffic-sources") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={filters}
        visibleCards={["source"]}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "traffic-clients") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={filters}
        visibleCards={["client"]}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "traffic-geo") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={filters}
        visibleCards={["geo"]}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "geo-map") {
    return (
      <OverviewGeoPointsMapCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  return (
    <OverviewMetricsSection
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
    />
  );
}

function RealtimeEmbedBlock({
  locale,
  messages,
  siteDomain,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  siteDomain: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  const filters = useRealtimeEmbedFilters();
  const realtimeEnabled = Boolean(siteId);
  const hasConnected = useRealtimeChannelSelector(
    siteId,
    (state) => state.hasConnected,
    Object.is,
    { enabled: realtimeEnabled },
  );
  const events = useRealtimeChannelSelector(
    siteId,
    (state) => state.events,
    Object.is,
    { enabled: realtimeEnabled },
  );
  const visits = useRealtimeChannelSelector(
    siteId,
    (state) => state.visits,
    Object.is,
    { enabled: realtimeEnabled },
  );

  if (view === "realtime-trend") {
    return (
      <RealtimeTrafficTrendCard
        locale={locale}
        messages={messages}
        hasConnected={hasConnected}
        events={events}
      />
    );
  }

  if (view === "realtime-breakdown") {
    return (
      <RealtimeSummaryCardsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        visits={visits}
        filters={filters}
      />
    );
  }

  return (
    <RealtimeLogStreamCard
      locale={locale}
      messages={messages}
      hasConnected={hasConnected}
      events={events}
      visits={visits}
    />
  );
}

function EventsEmbedBlock({
  locale,
  messages,
  pathname,
  siteDomain,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  siteDomain: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  const labels = messages.events;
  const { window: timeWindow } = useDashboardQuery();
  const filters = useOverviewEmbedFilters();
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const eventsQuery = useQuery({
    queryKey: [
      "embed",
      "landing-events",
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
  const summary = eventsQuery.data?.summary ?? emptyEventsSummary();
  const trend =
    eventsQuery.data?.trend ?? emptyEventsTrend(timeWindow.interval);
  const loading = eventsQuery.isPending;
  const eventCardDataOverride = useMemo(
    () => buildEventCardDataOverride(summary.cards.event.name),
    [summary.cards.event.name],
  );
  const contextCardDataOverride = useMemo(
    () => buildContextCardDataOverride(summary.cards.page),
    [summary.cards.page],
  );
  const siteBasePath = useMemo(
    () => pathname.replace(/\/events$/, ""),
    [pathname],
  );

  if (view === "events-trend") {
    return (
      <EventTrendStackedBarCard
        locale={locale}
        labels={labels}
        trend={trend}
        window={timeWindow}
        title={labels.trendTitle}
        loading={loading}
        cumulativeLabel={messages.common.cumulativeEvents}
      />
    );
  }

  if (view === "events-top") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={filters}
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
        pageCardDetailTabs={[]}
        pageCardShowVisitors
        primaryMetricLabel={labels.totalEvents}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "events-context") {
    return (
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={siteBasePath}
        filters={filters}
        cardDataOverride={contextCardDataOverride}
        visibleCards={["page"]}
        pageCardTabs={["path", "title", "hostname"]}
        primaryMetricLabel={labels.totalEvents}
        sectionClassName="xl:grid-cols-1"
      />
    );
  }

  if (view === "events-records") {
    return (
      <EventRecordsSection
        locale={locale}
        messages={messages}
        labels={labels}
        siteId={siteId}
        pathname={pathname}
        window={timeWindow}
        filters={filters}
      />
    );
  }

  return (
    <EventMetricGrid
      locale={locale}
      labels={labels}
      summary={summary.summary}
    />
  );
}

function BrowsersEmbedBlock({
  locale,
  messages,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  view: LandingEmbedView;
}) {
  const { filters, window } = useDashboardQuery();

  if (view === "browsers-trends") {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <BrowserShareTrendCard
          locale={locale}
          messages={messages}
          siteId={siteId}
          window={window}
          filters={filters}
        />
        <BrowserEngineShareTrendCard
          locale={locale}
          messages={messages}
          siteId={siteId}
          window={window}
          filters={filters}
        />
      </div>
    );
  }

  if (view === "browsers-versions") {
    return (
      <BrowserVersionBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  if (view === "browsers-cross") {
    return (
      <BrowserCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  if (view === "browsers-performance") {
    return (
      <BrowserPerformanceRadarCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  if (view === "browsers-compat") {
    return (
      <CanIUseCompatCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  return (
    <BrowserShareOverview
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
    />
  );
}

function DevicesEmbedBlock({
  locale,
  messages,
  siteDomain,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  siteDomain: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  const { filters, window } = useDashboardQuery();

  if (view === "devices-trends") {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <DeviceDimensionTrendCard
          locale={locale}
          messages={messages}
          siteId={siteId}
          window={window}
          filters={filters}
          dimension="deviceType"
          title={messages.devices.deviceTrendTitle}
        />
        <DeviceDimensionTrendCard
          locale={locale}
          messages={messages}
          siteId={siteId}
          window={window}
          filters={filters}
          dimension="operatingSystem"
          title={messages.devices.osTrendTitle}
        />
      </div>
    );
  }

  if (view === "devices-screens") {
    return (
      <DeviceScreenBreakdownCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        window={window}
        filters={filters}
      />
    );
  }

  if (view === "devices-cross") {
    return (
      <DeviceCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    );
  }

  return (
    <DeviceShareOverview
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
    />
  );
}

function LargeEmbedBlock({
  locale,
  messages,
  pathname,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  const baseProps = {
    locale,
    messages,
    siteId,
  } satisfies BaseDashboardPageProps;
  const pathProps = {
    ...baseProps,
    pathname,
  } satisfies PathDashboardPageProps;

  if (view === "retention") return <RetentionEmbed {...pathProps} />;
  if (view === "pages") return <PagesEmbed {...pathProps} />;
  if (view === "performance") return <PerformanceEmbed {...baseProps} />;
  if (view === "sessions") return <SessionsEmbed {...pathProps} />;
  if (view === "visitors") return <VisitorsEmbed {...pathProps} />;
  return <FunnelsEmbed {...pathProps} />;
}

function LandingEmbedBlock({
  locale,
  messages,
  pathname,
  siteDomain,
  siteId,
  view,
}: {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  siteDomain: string;
  siteId: string;
  view: LandingEmbedView;
}) {
  if (
    view === "overview-metrics" ||
    view === "traffic-trend" ||
    view === "traffic-pages" ||
    view === "traffic-sources" ||
    view === "traffic-clients" ||
    view === "traffic-geo" ||
    view === "geo-map"
  ) {
    return (
      <OverviewEmbedBlock
        locale={locale}
        messages={messages}
        pathname={pathname}
        siteDomain={siteDomain}
        siteId={siteId}
        view={view}
      />
    );
  }

  if (
    view === "realtime-trend" ||
    view === "realtime-stream" ||
    view === "realtime-breakdown"
  ) {
    return (
      <RealtimeEmbedBlock
        locale={locale}
        messages={messages}
        siteDomain={siteDomain}
        siteId={siteId}
        view={view}
      />
    );
  }

  if (
    view === "events-summary" ||
    view === "events-trend" ||
    view === "events-top" ||
    view === "events-context" ||
    view === "events-records"
  ) {
    return (
      <EventsEmbedBlock
        locale={locale}
        messages={messages}
        pathname={pathname}
        siteDomain={siteDomain}
        siteId={siteId}
        view={view}
      />
    );
  }

  if (
    view === "browsers-share" ||
    view === "browsers-trends" ||
    view === "browsers-versions" ||
    view === "browsers-cross" ||
    view === "browsers-performance" ||
    view === "browsers-compat"
  ) {
    return (
      <BrowsersEmbedBlock
        locale={locale}
        messages={messages}
        siteId={siteId}
        view={view}
      />
    );
  }

  if (
    view === "devices-share" ||
    view === "devices-trends" ||
    view === "devices-screens" ||
    view === "devices-cross"
  ) {
    return (
      <DevicesEmbedBlock
        locale={locale}
        messages={messages}
        siteDomain={siteDomain}
        siteId={siteId}
        view={view}
      />
    );
  }

  return (
    <LargeEmbedBlock
      locale={locale}
      messages={messages}
      pathname={pathname}
      siteId={siteId}
      view={view}
    />
  );
}

export function LandingEmbedClient({
  locale,
  messages,
  view,
}: LandingEmbedClientProps) {
  const site = LANDING_EMBED_DEMO_SITE;
  const embedView = normalizeLandingEmbedView(view);
  const pathname = buildLandingEmbedDemoSitePath(locale, embedView);

  return (
    <main
      className="min-h-svh bg-background px-4 py-4 text-foreground md:px-6 md:py-6"
      data-insightflare-landing-embed={embedView}
    >
      <DashboardQueryProvider
        scopeKey={`landing-embed:${embedView}:${site.siteId}`}
      >
        <div
          className={cn(
            "mx-auto w-full max-w-[1400px]",
            embedView === "events-records" && "max-w-[1600px]",
          )}
        >
          <LandingEmbedBlock
            locale={locale}
            messages={messages}
            pathname={pathname}
            siteDomain={site.siteDomain}
            siteId={site.siteId}
            view={embedView}
          />
        </div>
      </DashboardQueryProvider>
    </main>
  );
}
