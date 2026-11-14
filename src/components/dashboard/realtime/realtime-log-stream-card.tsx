import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailDrawer } from "@insightflare/product-ui/detail-drawer";
import {
  RealtimeLogStreamView,
  type RealtimeLogStreamViewItem,
} from "@insightflare/product-ui/realtime";
import { useReducedMotion } from "motion/react";

import { useDashboardQueryControls } from "@/components/dashboard/shell/dashboard-query-provider";
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/sessions/session-detail-client-page";
import { VisitorDetailClientPage } from "@/components/dashboard/site-pages/visitors/visitor-detail-client-page";
import { intlLocale, shortDateTime } from "@/lib/dashboard/format";
import { buildRealtimeLogStreamLabels } from "@/lib/product-ui-labels/realtime";
import type { RealtimeEvent } from "@/lib/realtime/types";

import { RealtimeLogEventDetailsDrawer } from "./log-stream-event-details";
import {
  INITIAL_VISIBLE_EVENTS,
  LOAD_MORE_STEP,
  NESTED_DRAWER_EXIT_DURATION_MS,
  type RealtimeLogStreamCardProps,
  type RealtimeNestedEventDetail,
  type RealtimeNestedJourneyDetail,
  resolveRealtimeEventDisplayData,
} from "./model";
export const RealtimeLogStreamCard = memo(function RealtimeLogStreamCard({
  locale,
  messages,
  hasConnected,
  events,
  siteId,
  pathname,
}: RealtimeLogStreamCardProps) {
  const { timeZone } = useDashboardQueryControls();
  const reduceLogItemMotion = useReducedMotion() ?? false;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_EVENTS);
  const [selectedEvent, setSelectedEvent] = useState<RealtimeEvent | null>(
    null,
  );
  const [isEventDetailsOpen, setIsEventDetailsOpen] = useState(false);
  const [nestedEventDetails, setNestedEventDetails] = useState<
    RealtimeNestedEventDetail[]
  >([]);
  const [nestedJourneyDetails, setNestedJourneyDetails] = useState<
    RealtimeNestedJourneyDetail[]
  >([]);
  const nestedEventDetailKeyRef = useRef(0);
  const nestedJourneyDetailKeyRef = useRef(0);
  const nestedEventDetailCloseTimersRef = useRef(new Map<string, number>());
  const nestedEventDetailsClearTimerRef = useRef<number | null>(null);
  const nestedJourneyDetailsClearTimerRef = useRef<number | null>(null);
  const selectedEventClearTimerRef = useRef<number | null>(null);

  const visibleEvents = useMemo(
    () => events.slice(0, visibleCount),
    [events, visibleCount],
  );
  const hasMoreEvents = visibleCount < events.length;
  const isInitialLoading = !hasConnected && visibleEvents.length === 0;
  const viewState = isInitialLoading
    ? "loading"
    : visibleEvents.length === 0
      ? "empty"
      : "ready";
  const labels = useMemo(
    () => buildRealtimeLogStreamLabels(messages),
    [messages],
  );
  const intlLocaleTag = intlLocale(locale);
  const items = useMemo<RealtimeLogStreamViewItem[]>(
    () =>
      visibleEvents.map((event) => {
        const display = resolveRealtimeEventDisplayData(
          locale,
          messages,
          event,
        );
        return {
          id: event.id,
          eventAt: event.eventAt,
          eventDateTime: shortDateTime(locale, event.eventAt, timeZone),
          title: display.title,
          avatarSeed: display.avatarSeed,
          browserLabel: display.browserLabel,
          browserIconKey: display.browserIconKey,
          osLabel: display.osLabel,
          osIconKey: display.osIconKey,
          countryLabel: display.countryLabel,
          countryFlagCode: display.countryFlagCode,
          sourceLabel: display.sourceLabel,
        };
      }),
    [locale, messages, timeZone, visibleEvents],
  );
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    setVisibleCount((previous) => {
      if (events.length <= 0) return INITIAL_VISIBLE_EVENTS;
      return Math.min(
        events.length,
        Math.max(previous, INITIAL_VISIBLE_EVENTS),
      );
    });
  }, [events.length]);

  const loadMoreEvents = useCallback(() => {
    if (!hasMoreEvents) return;
    setVisibleCount((previous) =>
      Math.min(events.length, previous + LOAD_MORE_STEP),
    );
  }, [events.length, hasMoreEvents]);
  const clearSelectedEventTimer = useCallback(() => {
    if (selectedEventClearTimerRef.current === null) return;
    window.clearTimeout(selectedEventClearTimerRef.current);
    selectedEventClearTimerRef.current = null;
  }, []);
  const handleEventSelect = useCallback(
    (event: RealtimeEvent) => {
      clearSelectedEventTimer();
      setSelectedEvent(event);
      setIsEventDetailsOpen(true);
    },
    [clearSelectedEventTimer],
  );
  const handleItemSelect = useCallback(
    (id: string) => {
      const event = eventsRef.current.find((candidate) => candidate.id === id);
      if (event) handleEventSelect(event);
    },
    [handleEventSelect],
  );
  const openNestedEventDetail = useCallback((event: RealtimeEvent) => {
    nestedEventDetailKeyRef.current += 1;
    setNestedEventDetails((current) => [
      ...current,
      {
        event,
        open: true,
        stackKey: `event:${event.id}:${nestedEventDetailKeyRef.current}`,
      },
    ]);
  }, []);
  const closeNestedEventDetail = useCallback((stackKey: string) => {
    setNestedEventDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      if (index < 0) return current;

      return current.map((item, itemIndex) =>
        itemIndex >= index ? { ...item, open: false } : item,
      );
    });

    if (nestedEventDetailCloseTimersRef.current.has(stackKey)) return;
    const timerId = window.setTimeout(() => {
      nestedEventDetailCloseTimersRef.current.delete(stackKey);
      setNestedEventDetails((current) => {
        const index = current.findIndex((item) => item.stackKey === stackKey);
        return index < 0 ? current : current.slice(0, index);
      });
    }, NESTED_DRAWER_EXIT_DURATION_MS);
    nestedEventDetailCloseTimersRef.current.set(stackKey, timerId);
  }, []);
  const openNestedJourneyDetail = useCallback(
    (kind: RealtimeNestedJourneyDetail["kind"], id: string) => {
      const normalizedId = id.trim();
      if (!normalizedId) return;

      setNestedJourneyDetails((current) => {
        const topDetail = current.at(-1);
        if (topDetail?.kind === kind && topDetail.id === normalizedId) {
          return current;
        }

        nestedJourneyDetailKeyRef.current += 1;
        return [
          ...current,
          {
            kind,
            id: normalizedId,
            open: true,
            stackKey: `${kind}:${normalizedId}:${nestedJourneyDetailKeyRef.current}`,
          },
        ];
      });
    },
    [],
  );
  const closeNestedJourneyDetail = useCallback((stackKey: string) => {
    setNestedJourneyDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);
  const handleEventDetailsOpenChange = useCallback(
    (open: boolean) => {
      clearSelectedEventTimer();
      setIsEventDetailsOpen(open);
      if (!open) {
        selectedEventClearTimerRef.current = window.setTimeout(() => {
          selectedEventClearTimerRef.current = null;
          setSelectedEvent(null);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
        setNestedEventDetails((current) =>
          current.map((item) => ({ ...item, open: false })),
        );
        if (nestedEventDetailsClearTimerRef.current !== null) {
          window.clearTimeout(nestedEventDetailsClearTimerRef.current);
        }
        nestedEventDetailsClearTimerRef.current = window.setTimeout(() => {
          nestedEventDetailsClearTimerRef.current = null;
          setNestedEventDetails([]);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
        setNestedJourneyDetails((current) =>
          current.map((item) => ({ ...item, open: false })),
        );
        if (nestedJourneyDetailsClearTimerRef.current !== null) {
          window.clearTimeout(nestedJourneyDetailsClearTimerRef.current);
        }
        nestedJourneyDetailsClearTimerRef.current = window.setTimeout(() => {
          nestedJourneyDetailsClearTimerRef.current = null;
          setNestedJourneyDetails([]);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
      }
    },
    [clearSelectedEventTimer],
  );

  useEffect(() => {
    return () => {
      clearSelectedEventTimer();
      nestedEventDetailCloseTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      nestedEventDetailCloseTimersRef.current.clear();
      if (nestedEventDetailsClearTimerRef.current !== null) {
        window.clearTimeout(nestedEventDetailsClearTimerRef.current);
      }
      if (nestedJourneyDetailsClearTimerRef.current !== null) {
        window.clearTimeout(nestedJourneyDetailsClearTimerRef.current);
      }
    };
  }, [clearSelectedEventTimer]);
  const journeyDetailContext =
    siteId && pathname
      ? {
          siteId,
          visitorsPathname: pathname.replace(
            /\/realtime(?:\/detail)?$/,
            "/visitors",
          ),
          sessionsPathname: pathname.replace(
            /\/realtime(?:\/detail)?$/,
            "/sessions",
          ),
        }
      : null;

  return (
    <>
      <RealtimeLogStreamView
        items={items}
        state={viewState}
        labels={labels}
        locale={intlLocaleTag}
        reduceMotion={reduceLogItemMotion}
        syncKey={`${visibleEvents.length}:${events.length}`}
        onReachEnd={hasMoreEvents ? loadMoreEvents : null}
        onSelect={handleItemSelect}
      />
      <RealtimeLogEventDetailsDrawer
        event={selectedEvent}
        locale={locale}
        messages={messages}
        timeZone={timeZone}
        events={events}
        onSelect={openNestedEventDetail}
        onOpenVisitor={
          journeyDetailContext
            ? (visitorId) => openNestedJourneyDetail("visitor", visitorId)
            : undefined
        }
        onOpenSession={
          journeyDetailContext
            ? (sessionId) => openNestedJourneyDetail("session", sessionId)
            : undefined
        }
        open={isEventDetailsOpen}
        onOpenChange={handleEventDetailsOpenChange}
      />
      {nestedEventDetails.map((nestedDetail) => (
        <RealtimeLogEventDetailsDrawer
          key={nestedDetail.stackKey}
          event={nestedDetail.event}
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          events={events}
          onSelect={openNestedEventDetail}
          onOpenVisitor={
            journeyDetailContext
              ? (visitorId) => openNestedJourneyDetail("visitor", visitorId)
              : undefined
          }
          onOpenSession={
            journeyDetailContext
              ? (sessionId) => openNestedJourneyDetail("session", sessionId)
              : undefined
          }
          open={nestedDetail.open}
          onOpenChange={(open) => {
            if (!open) closeNestedEventDetail(nestedDetail.stackKey);
          }}
        />
      ))}
      {journeyDetailContext
        ? nestedJourneyDetails.map((nestedDetail) => (
            <DetailDrawer
              key={nestedDetail.stackKey}
              ariaLabel={
                nestedDetail.kind === "visitor"
                  ? messages.visitors.title
                  : messages.sessionDetail.visitDetailsTitle
              }
              drawerKey={nestedDetail.stackKey}
              open={nestedDetail.open}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) closeNestedJourneyDetail(nestedDetail.stackKey);
              }}
            >
              {nestedDetail.kind === "visitor" ? (
                <VisitorDetailClientPage
                  locale={locale}
                  messages={messages}
                  siteId={journeyDetailContext.siteId}
                  pathname={journeyDetailContext.visitorsPathname}
                  visitorId={nestedDetail.id}
                  onOpenSession={(sessionId) =>
                    openNestedJourneyDetail("session", sessionId)
                  }
                />
              ) : (
                <SessionDetailClientPage
                  locale={locale}
                  messages={messages}
                  siteId={journeyDetailContext.siteId}
                  pathname={journeyDetailContext.sessionsPathname}
                  sessionId={nestedDetail.id}
                  onOpenVisitor={(visitorId) =>
                    openNestedJourneyDetail("visitor", visitorId)
                  }
                />
              )}
            </DetailDrawer>
          ))
        : null}
    </>
  );
});
