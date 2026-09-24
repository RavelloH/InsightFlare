import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  RiCalendarEventLine,
  RiLogoutBoxRLine,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";

import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLoader,
  type AsyncDimensionBreakdownRow,
} from "@/components/dashboard/common/async-dimension-breakdown-card";
import { useInfiniteTableSentinel } from "@/components/dashboard/common/use-infinite-table-sentinel";
import { LazyGeoCityBreadcrumbLabel } from "@/components/dashboard/geo/lazy-geo-location-label";
import {
  BrowserMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatScreen,
  formatShortDateTime,
  OsMeta,
  ReferrerMeta,
} from "@/components/dashboard/journeys/journey-display";
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
import { type OverviewTabRows } from "@/lib/dashboard/client/data/index";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import type {
  JourneyEvent,
  JourneySession,
} from "@/lib/dashboard-api/client/edge";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import {
  eventChronologyRank,
  eventDisplayTitle,
  eventSubtitle,
  type Labels,
  type SessionDetail,
} from "./model";
export function EventIcon({ event }: { event: JourneyEvent }) {
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
export function SummaryGridItem({
  label,
  value,
  mono = false,
  prominent = false,
  loading = false,
  className,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  prominent?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const valueClassName = prominent
    ? "h-7 text-xl font-semibold leading-7"
    : "h-5 text-xs leading-5";

  return (
    <div className={cn("min-w-0 bg-card p-4", className)}>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 min-w-0">
        <AutoTransition
          initial={false}
          transitionKey={loading ? "loading" : "ready"}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className={cn("min-w-0 overflow-hidden", valueClassName)}
        >
          {loading ? (
            <Skeleton
              key="loading"
              className={cn(
                valueClassName,
                prominent ? "w-20" : "w-[min(18rem,88%)]",
              )}
            />
          ) : (
            <div
              key="ready"
              className={cn(
                "min-w-0 overflow-hidden text-foreground [overflow-wrap:anywhere]",
                mono && "font-mono",
                valueClassName,
              )}
            >
              {value}
            </div>
          )}
        </AutoTransition>
      </div>
    </div>
  );
}
export function SummaryPathLink({
  pathname,
  onOpenPage,
}: {
  pathname: string;
  onOpenPage: (pagePath: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenPage(pathname || "/")}
      className="block min-w-0 truncate text-left font-mono text-xs text-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/60"
    >
      {formatPath(pathname)}
    </button>
  );
}
export function SessionGeoBreadcrumb({
  locale,
  messages,
  session,
}: {
  locale: Locale;
  messages: AppMessages;
  session: JourneySession;
}) {
  const country = resolveCountryLabel(
    session.country,
    locale,
    messages.common.unknown,
  );
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel =
    session.region.trim() ||
    session.regionCode.trim() ||
    messages.common.unknown;
  const cityLabel = session.city.trim() || messages.common.unknown;
  const hasRegion = Boolean(session.region.trim() || session.regionCode.trim());
  const hasCity = Boolean(session.city.trim());

  return (
    <LazyGeoCityBreadcrumbLabel
      locale={locale}
      countryLabel={country.label}
      countryIconName={flagCode ? `flagpack:${flagCode.toLowerCase()}` : null}
      regionLabel={regionLabel}
      cityLabel={cityLabel}
      countryCode={country.code ?? session.country}
      stateCode={session.regionCode || session.region}
      cityNameDefault={session.city}
      hideRegion={!hasRegion}
      hideCity={!hasCity}
    />
  );
}
export const MetaPanel = memo(function MetaPanel({
  locale,
  messages,
  labels,
  detail,
  onOpenPage,
  timeZone,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  onOpenPage: (pagePath: string) => void;
  timeZone: string;
  loading?: boolean;
}) {
  const session = detail.session;
  const firstEvent = detail.events.reduce<JourneyEvent | null>(
    (earliest, event) =>
      !earliest || event.occurredAt < earliest.occurredAt ? event : earliest,
    null,
  );
  const lastEvent = detail.events.reduce<JourneyEvent | null>(
    (latest, event) =>
      !latest || event.occurredAt > latest.occurredAt ? event : latest,
    null,
  );

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs text-muted-foreground xl:grid-cols-4">
          <SummaryGridItem
            label={labels.userName}
            loading={loading}
            value={session.userName || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.userId}
            mono
            loading={loading}
            value={session.userId || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.visitorId}
            mono
            loading={loading}
            value={session.visitorId || messages.common.unknown}
          />
          <SummaryGridItem
            label={labels.duration}
            prominent
            mono
            loading={loading}
            value={formatDuration(locale, session.durationMs)}
          />
          <SummaryGridItem
            label={labels.screenViews}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, session.views)}
          />
          <SummaryGridItem
            label={labels.events}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, session.events)}
          />
          <SummaryGridItem
            label={labels.uniquePages}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, detail.visitedPages.length)}
          />
          <SummaryGridItem
            label={labels.entryPath}
            className="col-span-2"
            loading={loading}
            value={
              <SummaryPathLink
                pathname={session.entryPath}
                onOpenPage={onOpenPage}
              />
            }
          />
          <SummaryGridItem
            label={labels.exitPath}
            className="col-span-2"
            loading={loading}
            value={
              <SummaryPathLink
                pathname={session.exitPath}
                onOpenPage={onOpenPage}
              />
            }
          />
          <SummaryGridItem
            label={labels.location}
            loading={loading}
            value={
              <SessionGeoBreadcrumb
                locale={locale}
                messages={messages}
                session={session}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerName}
            loading={loading}
            value={
              <ReferrerMeta
                referrerHost={session.referrerHost}
                referrerUrl={session.referrerUrl}
                directLabel={messages.overview.direct}
              />
            }
          />
          <SummaryGridItem
            className="col-span-2"
            label={labels.referrerUrl}
            mono
            loading={loading}
            value={session.referrerUrl || messages.overview.direct}
          />
          <SummaryGridItem
            label={labels.browser}
            loading={loading}
            value={
              <BrowserMeta
                browser={session.browser}
                version={session.browserVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.os}
            loading={loading}
            value={
              <OsMeta
                os={session.os}
                version={session.osVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.device}
            loading={loading}
            value={
              <DeviceMeta
                deviceType={session.deviceType}
                deviceLabels={messages.common.deviceLabels}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.screen}
            mono
            loading={loading}
            value={formatScreen(session.screenWidth, session.screenHeight)}
          />
          <SummaryGridItem
            label={labels.firstEvent}
            mono
            loading={loading}
            value={
              firstEvent
                ? formatShortDateTime(locale, firstEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.lastEvent}
            mono
            loading={loading}
            value={
              lastEvent
                ? formatShortDateTime(locale, lastEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.bounce}
            loading={loading}
            value={session.bounce ? labels.yes : labels.no}
          />
          <SummaryGridItem
            label={labels.status}
            loading={loading}
            value={session.active ? labels.active : labels.inactive}
          />
        </div>
      </CardContent>
    </Card>
  );
});
export const SessionEventCard = memo(function SessionEventCard({
  locale,
  messages,
  labels,
  event,
  deltaMs,
  timeZone,
  onOpenEvent,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  event: JourneyEvent;
  deltaMs: number | null;
  timeZone: string;
  onOpenEvent: (event: JourneyEvent) => void;
}) {
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
                {deltaMs !== null && deltaMs > 0 ? (
                  <p className="max-w-full break-words font-mono text-[10px] leading-[13px] text-muted-foreground">
                    {labels.sincePrevious}: {formatDuration(locale, deltaMs)}
                  </p>
                ) : (
                  <span className="h-[13px]" aria-hidden="true" />
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Clickable>
  );
});
export function SessionEventSkeletonCard() {
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
export const VisitDetailsTab = memo(function VisitDetailsTab({
  locale,
  messages,
  labels,
  events,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  timeZone,
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
  timeZone: string;
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
                  <SessionEventSkeletonCard key={`event-skeleton-${index}`} />
                ))}
              </div>
            ) : chronologicalEvents.length === 0 && !hasMore ? (
              <EmptyState key="empty">{labels.emptyEvents}</EmptyState>
            ) : (
              <div key={eventContentKey} className="space-y-1.5">
                {chronologicalEvents.map((event, index) => (
                  <SessionEventCard
                    key={event.id}
                    locale={locale}
                    messages={messages}
                    labels={labels}
                    event={event}
                    timeZone={timeZone}
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
                    <SessionEventSkeletonCard />
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
export const SESSION_DETAIL_OVERVIEW_FILTERS = EMPTY_DASHBOARD_FILTER_DOCUMENT;
export const SESSION_OVERVIEW_PAGE_CARD_TABS = ["path", "title"] as const;
export interface SessionOverviewRowInput {
  label: string;
  views?: number;
}
export function aggregateOverviewRows(
  rows: SessionOverviewRowInput[],
  fallbackLabel: string,
): OverviewTabRows {
  const rowByLabel = new globalThis.Map<string, OverviewTabRows[number]>();

  for (const row of rows) {
    const label = row.label.trim() || fallbackLabel;
    if (!label) continue;
    const views = Math.max(1, Math.floor(Number(row.views ?? 1)));
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += views;
      existing.sessions = Math.max(1, existing.sessions);
      existing.visitors = Math.max(1, existing.visitors);
      continue;
    }

    rowByLabel.set(label, {
      label,
      views,
      sessions: 1,
      visitors: 1,
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}
export function buildSessionOverviewPageCardData(
  detail: SessionDetail,
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
          pageviewEvents.map((event) => ({ label: event.pathname || "/" })),
          "/",
        );

  return {
    page: {
      path: pathRows,
      query: [],
      title: aggregateOverviewRows(
        pageviewEvents.map((event) => ({ label: event.title })),
        unknownLabel,
      ),
      hostname: aggregateOverviewRows(
        pageviewEvents.map((event) => ({ label: event.hostname })),
        unknownLabel,
      ),
      entry: aggregateOverviewRows(
        [{ label: detail.session.entryPath || "/", views: 1 }],
        "/",
      ),
      exit: aggregateOverviewRows(
        [{ label: detail.session.exitPath || "/", views: 1 }],
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
export function resolveSessionSiteDomain(detail: SessionDetail): string {
  for (const event of detail.events) {
    const hostname = event.hostname.trim();
    if (hostname) return hostname;
  }
  return "";
}
export function buildSessionEventBreakdownRows(
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
      mono: event.kind === "custom",
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}
export const SessionDetailBottomCards = memo(function SessionDetailBottomCards({
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
  detail: SessionDetail;
  siteId: string;
  siteBasePath: string;
  siteDomain: string;
  loading?: boolean;
}) {
  const pageCardData = useMemo(
    () => buildSessionOverviewPageCardData(detail, messages.common.unknown),
    [detail, messages.common.unknown],
  );
  const eventRows = useMemo(
    () => buildSessionEventBreakdownRows(detail.events, labels),
    [detail.events, labels],
  );
  const eventTabs = useMemo(
    () =>
      [
        {
          value: "event",
          label: labels.events,
          columnLabel: labels.events,
          primaryMetricLabel: labels.events,
        },
      ] as const,
    [labels.events],
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
          filters={SESSION_DETAIL_OVERVIEW_FILTERS}
          cardDataOverride={pageCardData}
          visibleCards={["page"]}
          pageCardTabs={SESSION_OVERVIEW_PAGE_CARD_TABS}
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
          requestKey={`session-detail-events:${detail.session.sessionId}:${locale}:${JSON.stringify(eventRows)}`}
          className="h-full"
          showVisitors={false}
          emptyLabel={labels.emptyCustomEvents}
        />
      </div>
    </section>
  );
});
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-24 items-center justify-center border border-dashed border-border px-4 py-6 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}
