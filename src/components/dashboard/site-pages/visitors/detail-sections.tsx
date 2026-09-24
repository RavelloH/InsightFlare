import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiCalendarEventLine,
  RiLogoutBoxRLine,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/common/analytics-table-column-settings";
import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLoader,
  type AsyncDimensionBreakdownRow,
} from "@/components/dashboard/common/async-dimension-breakdown-card";
import { useInfiniteTableSentinel } from "@/components/dashboard/common/use-infinite-table-sentinel";
import {
  BrowserMeta,
  DeviceMeta,
  formatDuration,
  formatScreen,
  formatShortDateTime,
  OsMeta,
  ReferrerMeta,
} from "@/components/dashboard/journeys/journey-display";
import { JourneyGeoLocationCard } from "@/components/dashboard/journeys/journey-geo-location-card";
import {
  createSessionTableColumnDefinitions,
  SESSION_TABLE_COLUMNS_STORAGE_KEY,
  type SessionSortKey,
  type SessionSortState,
  SessionsTableCard,
  type SessionsTableLabels,
} from "@/components/dashboard/sessions/sessions-table-card";
import { useDetailDrawerClose } from "@/components/dashboard/site-pages/common/detail-drawer";
import { EventDetailDrawer } from "@/components/dashboard/site-pages/events/event-detail-drawer";
import { OverviewPagesSection } from "@/components/dashboard/site-pages/overview/pages-section";
import { type OverviewPagesSectionCardData } from "@/components/dashboard/site-pages/overview/types";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchEventRecordDetail,
  fetchJourneyEventDetail,
  type OverviewTabRows,
} from "@/lib/dashboard/client/data/index";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import type {
  JourneyEvent,
  JourneySession,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

import {
  EmptyState,
  eventChronologyRank,
  eventDisplayTitle,
  eventSubtitle,
  formatSeenDateTime,
  type Labels,
  SummaryGridItem,
  VISITOR_DETAIL_OVERVIEW_FILTERS,
  VISITOR_OVERVIEW_PAGE_CARD_TABS,
  VISITOR_SESSION_SORT,
  type VisitorDetail,
  visitorDisplayEvents,
  visitorGeoLocationInputs,
  type VisitorOverviewRowInput,
  VisitorPerformancePanel,
} from "./model";
function EventIcon({ event }: { event: JourneyEvent }) {
  const isCustom = event.kind === "custom";
  const isSessionStart = event.kind === "session_start";
  const isLeave = event.kind === "leave";
  return (
    <span
      className={cn(
        "inline-flex size-[34px] shrink-0 self-center items-center justify-center rounded-none",
        isSessionStart && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        event.kind === "pageview" &&
          "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        isLeave && "bg-rose-500/15 text-rose-600 dark:text-rose-400",
        isCustom && "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      )}
    >
      {isSessionStart ? (
        <RiTimeLine className="size-4" />
      ) : isLeave ? (
        <RiLogoutBoxRLine className="size-4" />
      ) : isCustom ? (
        <RiPulseLine className="size-4" />
      ) : (
        <RiCalendarEventLine className="size-4" />
      )}
    </span>
  );
}
const VisitorMetaPanel = memo(function VisitorMetaPanel({
  locale,
  messages,
  labels,
  detail,
  timeZone,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  timeZone: string;
  loading?: boolean;
}) {
  const { visitor, metrics } = detail;
  const totalDurationMs = detail.sessions.reduce(
    (sum, session) => sum + Math.max(0, Number(session.durationMs || 0)),
    0,
  );
  const avgPagesPerSession =
    metrics.sessions > 0 ? metrics.views / metrics.sessions : 0;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs text-muted-foreground xl:grid-cols-4">
          <SummaryGridItem
            label={labels.userName}
            loading={loading}
            value={visitor.userName || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.userId}
            mono
            loading={loading}
            value={visitor.userId || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.visitorId}
            mono
            loading={loading}
            value={visitor.visitorId || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.totalDuration}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, totalDurationMs)}
          />
          <SummaryGridItem
            label={labels.views}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.views)}
          />
          <SummaryGridItem
            label={labels.events}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.totalEvents)}
          />
          <SummaryGridItem
            label={labels.uniquePages}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, detail.visitedPages.length)}
          />
          <SummaryGridItem
            label={labels.avgPagesPerSession}
            prominent
            mono
            loading={loading}
            value={avgPagesPerSession.toFixed(1)}
          />
          <SummaryGridItem
            label={labels.avgEventsPerSession}
            prominent
            mono
            loading={loading}
            value={metrics.avgEventsPerSession.toFixed(1)}
          />
          <SummaryGridItem
            label={messages.common.bounceRate}
            prominent
            mono
            loading={loading}
            value={percentFormat(locale, metrics.bounceRate)}
          />
          <SummaryGridItem
            label={labels.avgStay}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, metrics.avgDurationMs)}
          />
          <SummaryGridItem
            label={labels.referrerName}
            loading={loading}
            value={
              <ReferrerMeta
                referrerHost={visitor.referrerHost || ""}
                referrerUrl={visitor.referrerUrl}
                directLabel={messages.overview.direct}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerUrl}
            mono
            loading={loading}
            value={visitor.referrerUrl || messages.overview.direct}
          />
          <SummaryGridItem
            label={labels.location}
            className="col-span-2"
            loading={loading}
            value={
              <VisitorGeoBreadcrumb
                locale={locale}
                messages={messages}
                visitor={visitor}
              />
            }
          />
          <SummaryGridItem
            label={labels.browser}
            loading={loading}
            value={
              <BrowserMeta
                browser={visitor.browser || ""}
                version={visitor.browserVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.os}
            loading={loading}
            value={
              <OsMeta
                os={visitor.os || ""}
                version={visitor.osVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.device}
            loading={loading}
            value={
              <DeviceMeta
                deviceType={visitor.deviceType || ""}
                deviceLabels={messages.common.deviceLabels}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.screen}
            mono
            loading={loading}
            value={formatScreen(visitor.screenWidth, visitor.screenHeight)}
          />
          <SummaryGridItem
            label={labels.firstSeen}
            prominent
            mono
            loading={loading}
            value={formatSeenDateTime(
              locale,
              messages,
              metrics.firstSeenAt,
              timeZone,
            )}
          />
          <SummaryGridItem
            label={labels.lastSeen}
            prominent
            mono
            loading={loading}
            value={formatSeenDateTime(
              locale,
              messages,
              metrics.lastSeenAt,
              timeZone,
            )}
          />
          <SummaryGridItem
            label={labels.daysActive}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.daysActive)}
          />
          <SummaryGridItem
            label={labels.avgTimeBetweenSessions}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, metrics.avgTimeBetweenSessionsMs)}
          />
        </div>
      </CardContent>
    </Card>
  );
});
const VisitorEventCard = memo(function VisitorEventCard({
  locale,
  messages,
  labels,
  event,
  deltaMs,
  siteBasePath,
  timeZone,
  onOpenSession,
  onOpenEvent,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  event: JourneyEvent;
  deltaMs: number | null;
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenEvent: (event: JourneyEvent) => void;
}) {
  const sessionId = event.sessionId.trim();
  const sessionHref = `${siteBasePath}/sessions?detail=${encodeURIComponent(
    sessionId,
  )}`;

  return (
    <Clickable
      className="block w-full rounded-none text-left focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpenEvent(event)}
      enableHoverScale={false}
      tapScale={0.985}
      duration={0.14}
      aria-label={eventDisplayTitle(labels, event)}
    >
      <Card size="sm" className="border border-foreground/10 py-0 ring-0">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 px-1.5 py-1">
            <EventIcon event={event} />
            <div className="flex min-w-0 flex-1 items-stretch justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">
                  {eventDisplayTitle(labels, event)}
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-[14px] text-muted-foreground">
                  <span className="min-w-0 truncate leading-[14px]">
                    {eventSubtitle(
                      locale,
                      event,
                      messages.common.unknown,
                      timeZone,
                    )}
                  </span>
                </div>
              </div>
              <div className="flex h-[34px] min-w-0 w-[42%] shrink-0 flex-col items-end justify-between text-right sm:w-auto sm:max-w-[24rem]">
                <p className="font-mono text-[11px] leading-[14px] text-foreground">
                  {formatShortDateTime(locale, event.occurredAt, timeZone)}
                </p>
                <div className="max-w-full truncate font-mono text-[10px] leading-[13px] text-muted-foreground">
                  {deltaMs !== null && deltaMs > 0 ? (
                    <span>
                      {labels.sincePrevious}: {formatDuration(locale, deltaMs)}
                    </span>
                  ) : sessionId ? (
                    onOpenSession ? (
                      <button
                        type="button"
                        className="bg-transparent p-0 text-left hover:text-foreground hover:underline"
                        onClick={(clickEvent) => {
                          clickEvent.stopPropagation();
                          onOpenSession(sessionId);
                        }}
                        onKeyDown={(keyboardEvent) =>
                          keyboardEvent.stopPropagation()
                        }
                      >
                        {labels.sessionId}: {event.sessionId}
                      </button>
                    ) : (
                      <Link
                        href={sessionHref}
                        data-skip-page-transition=""
                        className="hover:text-foreground hover:underline"
                        onClick={(clickEvent) => clickEvent.stopPropagation()}
                        onKeyDown={(keyboardEvent) =>
                          keyboardEvent.stopPropagation()
                        }
                      >
                        {labels.sessionId}: {event.sessionId}
                      </Link>
                    )
                  ) : (
                    <span aria-hidden="true">--</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Clickable>
  );
});
function VisitorEventSkeletonCard() {
  return (
    <Card size="sm" className="border border-foreground/10 py-0 ring-0">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-1.5 py-1">
          <Skeleton className="size-[34px] shrink-0" />
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-[min(26rem,80%)]" />
              <Skeleton className="h-[14px] w-[min(18rem,68%)]" />
            </div>
            <div className="flex h-[34px] min-w-0 w-[42%] shrink-0 flex-col items-end justify-between text-right sm:w-auto sm:max-w-[24rem]">
              <Skeleton className="ml-auto h-[14px] w-24" />
              <Skeleton className="ml-auto h-[13px] w-20" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
const VisitDetailsCard = memo(function VisitDetailsCard({
  locale,
  messages,
  labels,
  events,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  siteBasePath,
  timeZone,
  onOpenSession,
  onOpenEvent,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  events: JourneyEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenEvent: (event: JourneyEvent) => void;
  loading?: boolean;
}) {
  const chronologicalEvents = useMemo(
    () =>
      [...events].sort((left, right) => {
        return (
          left.occurredAt - right.occurredAt ||
          eventChronologyRank(left) - eventChronologyRank(right) ||
          left.id.localeCompare(right.id)
        );
      }),
    [events],
  );
  const eventContentKey = loading ? "loading" : "content";
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    if (!loadingMore || !hasMore) loadMoreInFlightRef.current = false;
  }, [hasMore, loadingMore]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loadMoreInFlightRef.current || !onLoadMore) {
      return;
    }
    loadMoreInFlightRef.current = true;
    onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  const loadMoreSentinelRef = useInfiniteTableSentinel({
    enabled: Boolean(onLoadMore) && !loading && !loadingMore && hasMore,
    onReachEnd: loadMore,
    rootMargin: "0px",
    triggerDistance: 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiCalendarEventLine className="size-4" />
          {labels.visitDetailsTitle}
        </CardTitle>
        <CardDescription>{labels.visitDetailsSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <AutoResizer duration={0.24}>
          <AutoTransition
            initial={false}
            transitionKey={eventContentKey}
            duration={0.18}
            type="fade"
            presenceMode="wait"
          >
            {loading ? (
              <div key="loading" className="space-y-1.5" aria-busy="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <VisitorEventSkeletonCard key={`event-skeleton-${index}`} />
                ))}
              </div>
            ) : chronologicalEvents.length === 0 && !hasMore ? (
              <EmptyState key="empty">{labels.emptyEvents}</EmptyState>
            ) : (
              <div key={eventContentKey} className="space-y-1.5">
                {chronologicalEvents.map((event, index) => (
                  <VisitorEventCard
                    key={event.id}
                    locale={locale}
                    messages={messages}
                    labels={labels}
                    event={event}
                    siteBasePath={siteBasePath}
                    timeZone={timeZone}
                    onOpenSession={onOpenSession}
                    onOpenEvent={onOpenEvent}
                    deltaMs={
                      index > 0
                        ? event.occurredAt -
                          chronologicalEvents[index - 1].occurredAt
                        : null
                    }
                  />
                ))}
                {hasMore ? (
                  <div
                    ref={loadMoreSentinelRef}
                    aria-hidden="true"
                    className="min-h-[58px]"
                  >
                    <VisitorEventSkeletonCard />
                  </div>
                ) : null}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
});
function sortVisitorSessions(
  rows: JourneySession[],
  sort: SessionSortState,
): JourneySession[] {
  const direction = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const primary =
      sort.key === "durationMs"
        ? left.durationMs - right.durationMs
        : sort.key === "views"
          ? left.views - right.views
          : left.startedAt - right.startedAt;

    if (primary !== 0) return primary * direction;
    return (
      right.startedAt - left.startedAt ||
      left.sessionId.localeCompare(right.sessionId)
    );
  });
}
const ActivityAndSessionsSection = memo(function ActivityAndSessionsSection({
  locale,
  labels,
  messages,
  detail,
  siteBasePath,
  timeZone,
  onOpenSession,
  hasMoreSessions = false,
  loadingMoreSessions = false,
  onLoadMoreSessions,
  loading = false,
}: {
  locale: Locale;
  labels: Labels;
  messages: AppMessages;
  detail: VisitorDetail;
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  hasMoreSessions?: boolean;
  loadingMoreSessions?: boolean;
  onLoadMoreSessions?: () => void;
  loading?: boolean;
}) {
  const [sessionSort, setSessionSort] =
    useState<SessionSortState>(VISITOR_SESSION_SORT);
  const sessionTableLabels = useMemo<SessionsTableLabels>(
    () => ({
      title: "",
      subtitle: "",
      search: "",
      started: labels.started,
      sessionId: labels.sessionId,
      visitor: labels.visitor,
      anonymous: labels.anonymous,
      userId: labels.userId,
      userName: labels.userName,
      entryPage: labels.entryPath,
      exitPage: labels.exitPath,
      duration: labels.duration,
      referrer: labels.referrer,
      location: labels.location,
      os: labels.os,
      browser: labels.browser,
      device: labels.device,
      pageViews: labels.pageViews,
      customEvents: labels.customEvents,
      screenSize: messages.sessions.screenSize,
      exitTime: messages.sessions.exitTime,
      loadError: labels.loadError,
      empty: labels.emptySessions,
    }),
    [labels, messages.sessions.screenSize, messages.sessions.exitTime],
  );
  const sessionColumnDefinitions = useMemo(
    () => createSessionTableColumnDefinitions(sessionTableLabels),
    [sessionTableLabels],
  );
  const sessionColumns = useAnalyticsTableColumns({
    storageKey: SESSION_TABLE_COLUMNS_STORAGE_KEY,
    columns: sessionColumnDefinitions,
  });
  const sortedSessions = useMemo(
    () => sortVisitorSessions(detail.sessions, sessionSort),
    [detail.sessions, sessionSort],
  );
  const toggleSessionSort = useCallback((key: SessionSortKey) => {
    setSessionSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : {
            key,
            direction: "desc",
          },
    );
  }, []);
  const openSessionDetail = useCallback(
    (sessionId: string) => {
      if (onOpenSession) {
        onOpenSession(sessionId);
        return;
      }

      window.location.assign(
        `${siteBasePath}/sessions?detail=${encodeURIComponent(sessionId)}`,
      );
    },
    [onOpenSession, siteBasePath],
  );

  return (
    <section className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {labels.activity}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityGrid
            activity={detail.activity}
            locale={locale}
            timeZone={timeZone}
            loading={loading}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            {labels.sessionRecords}
          </h2>
          <AnalyticsTableColumnSettings
            columns={sessionColumnDefinitions}
            orderedIds={sessionColumns.orderedIds}
            visibleIds={sessionColumns.visibleIds}
            onOrderChange={sessionColumns.setOrder}
            onVisibilityChange={sessionColumns.setVisible}
            onReset={sessionColumns.reset}
            labels={messages.common.tableColumns}
          />
        </div>
        <SessionsTableCard
          locale={locale}
          messages={messages}
          labels={sessionTableLabels}
          rows={sortedSessions}
          onOpenSession={openSessionDetail}
          sort={sessionSort}
          onSort={toggleSessionSort}
          hasMore={hasMoreSessions}
          loadingMore={loadingMoreSessions}
          onLoadMore={onLoadMoreSessions}
          loadingRows={loading}
          skeletonRows={5}
          visibleColumnIds={sessionColumns.visibleIds}
        />
      </section>
    </section>
  );
});
function aggregateOverviewRows(
  rows: VisitorOverviewRowInput[],
  fallbackLabel: string,
): OverviewTabRows {
  const rowByLabel = new globalThis.Map<
    string,
    { label: string; views: number; sessionIds: Set<string> }
  >();

  for (const row of rows) {
    const label = row.label.trim() || fallbackLabel;
    if (!label) continue;
    const views = Math.max(1, Math.floor(Number(row.views ?? 1)));
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += views;
      if (row.sessionId) existing.sessionIds.add(row.sessionId);
      continue;
    }

    rowByLabel.set(label, {
      label,
      views,
      sessionIds: row.sessionId ? new Set([row.sessionId]) : new Set(),
    });
  }

  return Array.from(rowByLabel.values())
    .map((row) => ({
      label: row.label,
      views: row.views,
      sessions: Math.max(1, row.sessionIds.size),
      visitors: 1,
    }))
    .sort(
      (left, right) =>
        right.views - left.views || left.label.localeCompare(right.label),
    );
}
function buildVisitorOverviewPageCardData(
  detail: VisitorDetail,
  unknownLabel: string,
): OverviewPagesSectionCardData {
  const pageviewEvents = detail.events.filter(
    (event) => event.kind === "pageview",
  );
  const pathRows =
    detail.visitedPages.length > 0
      ? aggregateOverviewRows(
          detail.visitedPages.map((page) => ({
            label: page.pathname || "/",
            views: page.views,
          })),
          "/",
        )
      : aggregateOverviewRows(
          pageviewEvents.map((event) => ({
            label: event.pathname || "/",
            sessionId: event.sessionId,
          })),
          "/",
        );

  return {
    page: {
      path: pathRows,
      query: [],
      title: aggregateOverviewRows(
        pageviewEvents.map((event) => ({
          label: event.title,
          sessionId: event.sessionId,
        })),
        unknownLabel,
      ),
      hostname: aggregateOverviewRows(
        pageviewEvents.map((event) => ({
          label: event.hostname,
          sessionId: event.sessionId,
        })),
        unknownLabel,
      ),
      entry: aggregateOverviewRows(
        detail.sessions.map((session) => ({
          label: session.entryPath || "/",
          sessionId: session.sessionId,
        })),
        "/",
      ),
      exit: aggregateOverviewRows(
        detail.sessions.map((session) => ({
          label: session.exitPath || "/",
          sessionId: session.sessionId,
        })),
        "/",
      ),
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
function resolveVisitorSiteDomain(detail: VisitorDetail): string {
  for (const event of detail.events) {
    const hostname = event.hostname.trim();
    if (hostname) return hostname;
  }
  return "";
}
function buildVisitorEventBreakdownRows(
  events: JourneyEvent[],
  labels: Labels,
): AsyncDimensionBreakdownRow[] {
  const rowByLabel = new globalThis.Map<string, AsyncDimensionBreakdownRow>();

  for (const event of events) {
    if (event.kind !== "custom") continue;
    const label = event.eventType.trim() || labels.customEvent;
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += 1;
      continue;
    }

    rowByLabel.set(label, {
      key: label,
      label,
      views: 1,
      visitors: 1,
      mono: true,
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}
const VisitorDetailBottomCards = memo(function VisitorDetailBottomCards({
  locale,
  messages,
  labels,
  detail,
  siteId,
  siteBasePath,
  siteDomain,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  siteId: string;
  siteBasePath: string;
  siteDomain: string;
  loading?: boolean;
}) {
  const pageCardData = useMemo(
    () => buildVisitorOverviewPageCardData(detail, messages.common.unknown),
    [detail, messages.common.unknown],
  );
  const eventRows = useMemo(
    () => buildVisitorEventBreakdownRows(detail.events, labels),
    [detail.events, labels],
  );
  const eventTabs = useMemo(
    () =>
      [
        {
          value: "event",
          label: labels.customEvents,
          columnLabel: labels.customEvents,
          primaryMetricLabel: labels.customEvents,
        },
      ] as const,
    [labels.customEvents],
  );
  const eventLoader = useMemo<AsyncDimensionBreakdownLoader<"event">>(
    () =>
      async ({ cursor, limit, search, sort }) =>
        loadLocalTablePage({
          rows: eventRows,
          sort: {
            key: sort.key === "visitors" ? "visitors" : "views",
            direction: sort.direction,
          },
          columns: [
            { key: "views", getValue: (row) => row.views },
            { key: "visitors", getValue: (row) => row.visitors },
          ],
          tab: "event",
          limit,
          cursor,
          search,
          getSearchText: (row) => row.label,
        }),
    [eventRows],
  );

  return (
    <section className="grid items-stretch gap-6 xl:grid-cols-2">
      <div className="min-w-0 h-full [&>section]:h-full [&>section]:!grid-cols-1 [&>section>div]:h-full">
        <OverviewPagesSection
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={siteBasePath}
          filters={VISITOR_DETAIL_OVERVIEW_FILTERS}
          cardDataOverride={pageCardData}
          visibleCards={["page"]}
          pageCardTabs={VISITOR_OVERVIEW_PAGE_CARD_TABS}
          pageCardShowVisitors={false}
          loading={loading}
        />
      </div>

      <div className="min-w-0 h-full">
        <AsyncDimensionBreakdownCard
          locale={locale}
          messages={messages}
          tabs={eventTabs}
          loader={eventLoader}
          requestKey={`visitor-detail-events:${detail.visitor.visitorId}:${locale}:${JSON.stringify(eventRows)}`}
          className="h-full"
          showVisitors={false}
          emptyLabel={labels.emptyCustomEvents}
        />
      </div>
    </section>
  );
});
import {
  ActivityGrid,
  VisitorGeoBreadcrumb,
  VisitorMapHero,
} from "./visual-sections";
export function DetailContent({
  locale,
  messages,
  labels,
  detail,
  siteId,
  pathname,
  timeZone,
  timeWindow,
  onOpenSession,
  hasMoreSessions = false,
  loadingMoreSessions = false,
  onLoadMoreSessions,
  hasMoreEvents = false,
  loadingMoreEvents = false,
  onLoadMoreEvents,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  siteId: string;
  pathname: string;
  timeZone: string;
  timeWindow: TimeWindow;
  onOpenSession?: (sessionId: string) => void;
  hasMoreSessions?: boolean;
  loadingMoreSessions?: boolean;
  onLoadMoreSessions?: () => void;
  hasMoreEvents?: boolean;
  loadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => void;
  loading?: boolean;
}) {
  const modalClose = useDetailDrawerClose();
  const visitorListPath = pathname.replace(/\/detail$/, "");
  const siteBasePath = visitorListPath.replace(/\/visitors$/, "");
  const visitorSiteDomain = useMemo(
    () => resolveVisitorSiteDomain(detail),
    [detail],
  );
  const displayEvents = useMemo(() => visitorDisplayEvents(detail), [detail]);
  const geoLocations = useMemo(
    () => visitorGeoLocationInputs(detail),
    [detail],
  );
  const [selectedEvent, setSelectedEvent] = useState<JourneyEvent | null>(null);
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
      <VisitorMapHero
        locale={locale}
        labels={labels}
        visitor={detail.visitor}
        metrics={detail.metrics}
        sessions={detail.sessions}
        backHref={visitorListPath}
        onBack={modalClose ?? undefined}
        loading={loading}
      />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <VisitorMetaPanel
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          timeZone={timeZone}
          loading={loading}
        />

        <ActivityAndSessionsSection
          locale={locale}
          labels={labels}
          messages={messages}
          detail={detail}
          siteBasePath={siteBasePath}
          timeZone={timeZone}
          onOpenSession={onOpenSession}
          hasMoreSessions={hasMoreSessions}
          loadingMoreSessions={loadingMoreSessions}
          onLoadMoreSessions={onLoadMoreSessions}
          loading={loading}
        />

        <VisitDetailsCard
          locale={locale}
          messages={messages}
          labels={labels}
          events={displayEvents}
          hasMore={hasMoreEvents}
          loadingMore={loadingMoreEvents}
          onLoadMore={onLoadMoreEvents}
          siteBasePath={siteBasePath}
          timeZone={timeZone}
          onOpenSession={onOpenSession}
          onOpenEvent={setSelectedEvent}
          loading={loading}
        />

        <VisitorDetailBottomCards
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          siteId={siteId}
          siteBasePath={siteBasePath}
          siteDomain={visitorSiteDomain}
          loading={loading}
        />

        <JourneyGeoLocationCard
          locale={locale}
          messages={messages}
          title={labels.geoLocationTitle}
          locations={geoLocations}
          loading={loading}
        />

        <VisitorPerformancePanel
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
      </div>
    </div>
  );
}
