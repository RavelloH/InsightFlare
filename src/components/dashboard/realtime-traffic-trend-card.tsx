import { useEffect, useMemo, useState } from "react";
import { RiPulseLine } from "@remixicon/react";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import {
  RealtimeRollingTrendChartIsland,
  type RealtimeRollingTrendPoint,
} from "@/components/dashboard/realtime-rolling-trend-chart-island";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeEvent } from "@/lib/realtime/types";

interface RealtimeTrafficTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  hasConnected: boolean;
  events: RealtimeEvent[];
}

const TREND_WINDOW_MINUTES = 30;
const MINUTE_MS = 60 * 1000;
const VIEW_EVENT_TYPES = new Set(["visit", "pageview"]);

function floorToMinute(timestampMs: number): number {
  return Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;
}

function buildRealtimeTrendData(
  events: RealtimeEvent[],
  now: number,
): RealtimeRollingTrendPoint[] {
  const rangeEnd = floorToMinute(now);
  const rangeStart = rangeEnd - (TREND_WINDOW_MINUTES - 1) * MINUTE_MS;
  const points = Array.from({ length: TREND_WINDOW_MINUTES }, (_, index) => ({
    timestampMs: rangeStart + index * MINUTE_MS,
    views: 0,
    sessions: 0,
  }));
  const pointIndexByTimestamp = new Map(
    points.map((point, index) => [point.timestampMs, index] as const),
  );
  const bucketVisitors = Array.from(
    { length: TREND_WINDOW_MINUTES },
    () => new Set<string>(),
  );

  for (const event of events) {
    if (!VIEW_EVENT_TYPES.has(event.eventType)) continue;

    const bucketTimestamp = floorToMinute(event.eventAt);
    const pointIndex = pointIndexByTimestamp.get(bucketTimestamp);
    if (pointIndex === undefined) continue;

    const point = points[pointIndex];
    if (!point) continue;

    point.views += 1;
    const visitorId = event.visitorId.trim();
    if (visitorId) {
      bucketVisitors[pointIndex]?.add(visitorId);
    }
  }

  return points.map((point, index) => ({
    ...point,
    sessions: bucketVisitors[index]?.size ?? 0,
  }));
}

export function RealtimeTrafficTrendCard({
  locale,
  messages,
  hasConnected,
  events,
}: RealtimeTrafficTrendCardProps) {
  const { timeZone } = useDashboardQueryControls();
  const [now, setNow] = useState(() => floorToMinute(Date.now()));

  useEffect(() => {
    let timeoutId: number | null = null;
    const scheduleNextMinute = () => {
      const delay = Math.max(1, MINUTE_MS - (Date.now() % MINUTE_MS) + 1);
      timeoutId = window.setTimeout(() => {
        setNow(floorToMinute(Date.now()));
        scheduleNextMinute();
      }, delay);
    };

    scheduleNextMinute();

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  const trendData = useMemo(
    () => buildRealtimeTrendData(events, now),
    [events, now],
  );
  const isInitialLoading = !hasConnected && events.length === 0;

  return (
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiPulseLine className="size-4" />
          {messages.overview.trendTitle}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <RealtimeRollingTrendChartIsland
            locale={locale}
            data={trendData}
            viewsLabel={messages.common.views}
            sessionsLabel={messages.common.visitors}
            timeZone={timeZone}
          />
          <AutoTransition
            type="fade"
            duration={0.22}
            className="pointer-events-none absolute right-2 top-2"
          >
            {isInitialLoading ? (
              <span
                key="realtime-trend-loading"
                className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
              >
                <Spinner className="size-3.5" />
                {messages.common.loading}
              </span>
            ) : (
              <div
                key="realtime-trend-idle"
                className="h-0 w-0 overflow-hidden"
              />
            )}
          </AutoTransition>
        </div>
      </CardContent>
    </Card>
  );
}
