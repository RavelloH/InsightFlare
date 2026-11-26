import { memo, useMemo } from "react";
import { Card, CardContent } from "@insightflare/ui/card";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { JourneyDetailStateSwitch } from "@/components/dashboard/journeys/journey-detail-state";
import { useDashboardTimeQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import { visitorDetailQueryOptions } from "@/lib/dashboard/client/data/visitors";

import { DetailContent } from "./detail-sections";
import {
  createVisitorDetailPlaceholder,
  type VisitorDetailClientPageProps,
} from "./model";
export const VisitorDetailClientPage = memo(function VisitorDetailClientPage({
  locale,
  messages,
  siteId,
  pathname,
  visitorId,
  onOpenSession,
}: VisitorDetailClientPageProps) {
  const labels = messages.visitorDetail;
  const { window, queryReady } = useDashboardTimeQuery();
  const timeZone = window.timeZone;
  const options = visitorDetailQueryOptions({
    siteId,
    visitorId,
    window,
    queryReady,
  });
  const detailQuery = useQuery(options.detail);
  const sessionsQuery = useInfiniteQuery(options.sessions);
  const eventsQuery = useInfiniteQuery(options.events);
  const summary = detailQuery.data?.data ?? null;
  const detail = useMemo(
    () =>
      summary
        ? {
            ...summary,
            sessions:
              sessionsQuery.data?.pages.flatMap((page) => page.data.items) ??
              summary.sessions ??
              [],
            events:
              eventsQuery.data?.pages.flatMap((page) => page.data.items) ??
              summary.events ??
              [],
          }
        : null,
    [summary, sessionsQuery.data, eventsQuery.data],
  );
  const sessionsPending = sessionsQuery.isPending && !summary?.sessions?.length;
  const eventsPending = eventsQuery.isPending && !summary?.events?.length;
  const sessionsError =
    sessionsQuery.isError && !sessionsQuery.data && !summary?.sessions?.length;
  const eventsError =
    eventsQuery.isError && !eventsQuery.data && !summary?.events?.length;
  const loading = detailQuery.isPending && !summary;
  const error = detailQuery.isError;

  if (!visitorId) {
    return (
      <JourneyDetailStateSwitch stateKey="visitor-missing">
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
      <JourneyDetailStateSwitch stateKey="visitor-error">
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
      <JourneyDetailStateSwitch stateKey="visitor-not-found">
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
      detail={detail ?? createVisitorDetailPlaceholder(visitorId)}
      siteId={siteId}
      pathname={pathname}
      timeZone={timeZone}
      timeWindow={window}
      onOpenSession={onOpenSession}
      sessionsPending={sessionsPending}
      sessionsError={sessionsError}
      hasMoreSessions={Boolean(sessionsQuery.hasNextPage)}
      loadingMoreSessions={sessionsQuery.isFetchingNextPage}
      onLoadMoreSessions={() => {
        if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
          void sessionsQuery.fetchNextPage();
        }
      }}
      eventsPending={eventsPending}
      eventsError={eventsError}
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
VisitorDetailClientPage.displayName = "VisitorDetailClientPage";
