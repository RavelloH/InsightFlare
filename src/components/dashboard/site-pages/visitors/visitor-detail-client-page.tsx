import { memo, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { JourneyDetailStateSwitch } from "@/components/dashboard/journeys/journey-detail-state";
import { useDashboardQueryControls } from "@/components/dashboard/shell/dashboard-query-provider";
import { Card, CardContent } from "@/components/ui/card";
import {
  fetchVisitorDetail,
  fetchVisitorEvents,
  fetchVisitorSessions,
} from "@/lib/dashboard/client/data/index";

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
  const { timeZone, window } = useDashboardQueryControls();
  const requestKey = useMemo(
    () => [siteId, visitorId, timeZone, window.from, window.to].join(":"),
    [siteId, timeZone, visitorId, window.from, window.to],
  );

  const detailQuery = useQuery({
    queryKey: ["dashboard", "visitor-detail", requestKey],
    queryFn: ({ signal }) =>
      fetchVisitorDetail(siteId, visitorId, timeZone, window, { signal }),
    enabled: typeof window !== "undefined" && Boolean(visitorId),
  });
  const summary = detailQuery.data?.data ?? null;
  const sessionsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "visitor-detail-sessions",
      siteId,
      visitorId,
      timeZone,
      window.from,
      window.to,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchVisitorSessions(siteId, visitorId, window, {
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: Boolean(summary && visitorId),
  });
  const eventsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "visitor-detail-events",
      siteId,
      visitorId,
      timeZone,
      window.from,
      window.to,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchVisitorEvents(siteId, visitorId, window, {
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: Boolean(summary && visitorId),
  });
  const loadedSessions = sessionsQuery.data
    ? sessionsQuery.data.pages.flatMap((page) => page.data.items)
    : (summary?.sessions ?? []);
  const loadedEvents = eventsQuery.data
    ? eventsQuery.data.pages.flatMap((page) => page.data.items)
    : (summary?.events ?? []);
  const detail = summary
    ? {
        ...summary,
        sessions: loadedSessions,
        events: loadedEvents,
      }
    : null;
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
      hasMoreSessions={Boolean(sessionsQuery.hasNextPage)}
      loadingMoreSessions={sessionsQuery.isFetchingNextPage}
      onLoadMoreSessions={() => {
        if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
          void sessionsQuery.fetchNextPage();
        }
      }}
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
