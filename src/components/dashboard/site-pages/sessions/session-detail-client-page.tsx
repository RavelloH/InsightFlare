import { memo, useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { JourneyDetailStateSwitch } from "@/components/dashboard/journeys/journey-detail-state";
import { JourneyGeoLocationCard } from "@/components/dashboard/journeys/journey-geo-location-card";
import { useDashboardQueryControls } from "@/components/dashboard/shell/dashboard-query-provider";
import { useDetailDrawerClose } from "@/components/dashboard/site-pages/common/detail-drawer";
import { EventDetailDrawer } from "@/components/dashboard/site-pages/events/event-detail-drawer";
import { PageDetailDrawer } from "@/components/dashboard/site-pages/pages/page-detail-drawer";
import { Card, CardContent } from "@/components/ui/card";
import {
  fetchEventRecordDetail,
  fetchJourneyEventDetail,
  fetchSessionDetail,
  fetchSessionEvents,
} from "@/lib/dashboard/client/data/index";
import { normalizePagePath } from "@/lib/dashboard/page-detail";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { JourneyEvent } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
interface SessionDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  sessionId: string;
  onOpenVisitor?: (visitorId: string) => void;
}
function DetailContent({
  locale,
  messages,
  labels,
  detail,
  siteId,
  pathname,
  timeZone,
  timeWindow,
  onOpenVisitor,
  hasMoreEvents = false,
  loadingMoreEvents = false,
  onLoadMoreEvents,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  siteId: string;
  pathname: string;
  timeZone: string;
  timeWindow: TimeWindow;
  onOpenVisitor?: (visitorId: string) => void;
  hasMoreEvents?: boolean;
  loadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => void;
  loading?: boolean;
}) {
  const modalClose = useDetailDrawerClose();
  const session = detail.session;
  const sessionsPath = pathname.replace(/\/detail$/, "");
  const siteBasePath = sessionsPath.replace(/\/sessions$/, "");
  const sessionSiteDomain = useMemo(
    () => resolveSessionSiteDomain(detail),
    [detail],
  );
  const visitorHref = `${siteBasePath}/visitors?detail=${encodeURIComponent(
    session.visitorId,
  )}`;
  const geoLocations = useMemo(
    () => sessionGeoLocationInputs(detail),
    [detail],
  );
  const [selectedEvent, setSelectedEvent] = useState<JourneyEvent | null>(null);
  const [pageDetailPath, setPageDetailPath] = useState<string | null>(null);
  const openPageDetail = useCallback((pagePath: string) => {
    setPageDetailPath(normalizePagePath(pagePath));
  }, []);
  const eventDetailQuery = useQuery({
    queryKey: [
      "dashboard",
      "journey-event-detail",
      siteId,
      selectedEvent?.id ?? "",
      selectedEvent?.kind ?? "",
      selectedEvent?.sessionId ?? "",
      selectedEvent?.visitId ?? "",
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
    ],
    queryFn: ({ signal }) => {
      if (!selectedEvent) throw new Error("Event selection is required");
      if (selectedEvent.kind === "custom") {
        return fetchEventRecordDetail(siteId, selectedEvent.id, timeWindow, {
          signal,
          preserveErrors: true,
        });
      }
      return fetchJourneyEventDetail(
        siteId,
        selectedEvent.id,
        selectedEvent.kind,
        timeWindow,
        {
          sessionId: selectedEvent.sessionId,
          visitId: selectedEvent.visitId,
          signal,
          preserveErrors: true,
        },
      );
    },
    enabled: typeof window !== "undefined" && Boolean(selectedEvent),
  });
  const eventDetail = eventDetailQuery.data?.data ?? null;
  const eventDetailLoading = eventDetailQuery.isPending && !eventDetail;
  const eventDetailError = eventDetailQuery.isError && !eventDetail;

  return (
    <div className="pb-6">
      <SessionMapHero
        locale={locale}
        labels={labels}
        session={session}
        locationPoints={detail.locationPoints}
        backHref={sessionsPath}
        visitorHref={visitorHref}
        onBack={modalClose ?? undefined}
        onOpenVisitor={onOpenVisitor}
        loading={loading}
      />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <MetaPanel
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          onOpenPage={openPageDetail}
          timeZone={timeZone}
          loading={loading}
        />

        <section>
          <VisitDetailsTab
            locale={locale}
            messages={messages}
            labels={labels}
            events={detail.events}
            hasMore={hasMoreEvents}
            loadingMore={loadingMoreEvents}
            onLoadMore={onLoadMoreEvents}
            timeZone={timeZone}
            onOpenEvent={setSelectedEvent}
            loading={loading}
          />
        </section>

        <SessionDetailBottomCards
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          siteId={siteId}
          siteBasePath={siteBasePath}
          siteDomain={sessionSiteDomain}
          loading={loading}
        />

        <JourneyGeoLocationCard
          locale={locale}
          messages={messages}
          title={labels.geoLocationTitle}
          locations={geoLocations}
          loading={loading}
        />

        <SessionPerformancePanel
          locale={locale}
          messages={messages}
          labels={labels}
          performance={detail.performance}
          loading={loading}
        />

        <EventDetailDrawer
          locale={locale}
          messages={messages}
          labels={messages.events}
          siteId={siteId}
          pathname={pathname}
          siteBasePath={siteBasePath}
          open={Boolean(selectedEvent)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSelectedEvent(null);
          }}
          detail={eventDetail}
          loading={eventDetailLoading}
          error={eventDetailError}
          eventKind={selectedEvent?.kind ?? "pageview"}
        />

        {pageDetailPath ? (
          <PageDetailDrawer
            locale={locale}
            messages={messages}
            siteId={siteId}
            siteDomain={sessionSiteDomain}
            pathname={siteBasePath}
            pagePath={pageDetailPath}
            onOpenChange={(open) => {
              if (!open) setPageDetailPath(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
import {
  MetaPanel,
  resolveSessionSiteDomain,
  SessionDetailBottomCards,
  sessionGeoLocationInputs,
  SessionMapHero,
  SessionPerformancePanel,
  VisitDetailsTab,
} from "./session-detail/components";
import {
  createSessionDetailPlaceholder,
  type Labels,
  type SessionDetail,
} from "./session-detail/model";
export const SessionDetailClientPage = memo(function SessionDetailClientPage({
  locale,
  messages,
  siteId,
  pathname,
  sessionId,
  onOpenVisitor,
}: SessionDetailClientPageProps) {
  const labels = messages.sessionDetail;
  const { timeZone, window } = useDashboardQueryControls();
  const requestKey = useMemo(
    () => [siteId, sessionId, timeZone, window.from, window.to].join(":"),
    [sessionId, siteId, timeZone, window.from, window.to],
  );

  const detailQuery = useQuery({
    queryKey: ["dashboard", "session-detail", requestKey],
    queryFn: ({ signal }) =>
      fetchSessionDetail(siteId, sessionId, timeZone, window, { signal }),
    enabled: typeof window !== "undefined" && Boolean(sessionId),
  });
  const summary = detailQuery.data?.data ?? null;
  const eventsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "session-detail-events",
      siteId,
      sessionId,
      timeZone,
      window.from,
      window.to,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchSessionEvents(siteId, sessionId, window, {
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: Boolean(summary && sessionId),
  });
  const loadedEvents = eventsQuery.data
    ? eventsQuery.data.pages.flatMap((page) => page.data.items)
    : (summary?.events ?? []);
  const detail = summary ? { ...summary, events: loadedEvents } : null;
  const loading = detailQuery.isPending && !summary;
  const error = detailQuery.isError;

  if (!sessionId) {
    return (
      <JourneyDetailStateSwitch stateKey="session-missing">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.missing}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  if (error && !detail) {
    return (
      <JourneyDetailStateSwitch stateKey="session-error">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.loadError}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  if (!detail && !loading) {
    return (
      <JourneyDetailStateSwitch stateKey="session-not-found">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.notFound}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  return (
    <DetailContent
      locale={locale}
      messages={messages}
      labels={labels}
      detail={detail ?? createSessionDetailPlaceholder(sessionId)}
      siteId={siteId}
      pathname={pathname}
      timeZone={timeZone}
      timeWindow={window}
      onOpenVisitor={onOpenVisitor}
      hasMoreEvents={Boolean(eventsQuery.hasNextPage)}
      loadingMoreEvents={eventsQuery.isFetchingNextPage}
      onLoadMoreEvents={() => {
        if (eventsQuery.hasNextPage && !eventsQuery.isFetchingNextPage) {
          void eventsQuery.fetchNextPage();
        }
      }}
      loading={loading}
    />
  );
});
SessionDetailClientPage.displayName = "SessionDetailClientPage";
