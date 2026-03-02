"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Activity, BookOpen, Clock, Globe2, Layers, Route, Users } from "lucide-react";
import { Widget, WidgetBody, WidgetFooter, WidgetHead } from "@/components/widget/widget";
import { OverviewGrid, type MetricKey } from "@/components/dashboard/overview-grid";
import { TrendAreaChart } from "@/components/charts/trend-area-chart";
import { BreakdownList } from "@/components/dashboard/breakdown-list";
import { SessionCompactList } from "@/components/dashboard/session-compact-list";
import { RealtimeEventList } from "@/components/dashboard/realtime-event-list";
import { EventsTable } from "@/components/dashboard/events-table";
import { VisitorTable } from "@/components/dashboard/visitor-table";
import type {
  EventsData,
  OverviewData,
  PagesData,
  ReferrersData,
  SessionsData,
  TrendPoint,
  VisitorsData,
} from "@/lib/edge-client";

type ChartMetric = "views" | "sessions";

interface DashboardClientProps {
  overview: OverviewData["data"];
  trend: TrendPoint[];
  pages: PagesData["data"];
  referrers: ReferrersData["data"];
  sessions: SessionsData["data"];
  events: EventsData["data"];
  visitors: VisitorsData["data"];
  interval: "hour" | "day";
  teamId: string;
  siteId: string;
  wsBaseUrl: string;
  wsToken: string;
  locale: string;
  labels: {
    views: string;
    sessions: string;
    visitors: string;
    bounceRate: string;
    avgDuration: string;
    hintViews: string;
    hintSessions: string;
    hintVisitorsExact: string;
    hintVisitorsApprox: string;
    hintBounce: string;
    hintDuration: string;
    topPages: string;
    topReferrers: string;
    topSources: string;
    topDevices: string;
    topCountries: string;
    topEventsBreakdown: string;
    sessionSnapshot: string;
    noSessions: string;
    realtimeStream: string;
    wsHint: string;
    waitingLive: string;
    direct: string;
    recentEvents: string;
    profiles: string;
    noEvents?: string;
    noVisitors?: string;
    viewAllPages?: string;
    viewAllSessions?: string;
    viewAllEvents?: string;
    viewAllProfiles?: string;
    fullRealtimeView?: string;
  };
}

const metricToChart: Record<MetricKey, ChartMetric | undefined> = {
  views: "views",
  sessions: "sessions",
  visitors: undefined,
  bounceRate: undefined,
  avgDuration: undefined,
};

interface GroupItem {
  id: string;
  label: string;
  value: number;
}

function topGroups(
  rows: string[],
  maxItems = 8,
  normalize: (value: string) => string = (value) => value,
): GroupItem[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = normalize(row || "");
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([id, value]) => ({ id, label: id, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, maxItems);
}

export function DashboardClient({
  overview,
  trend,
  pages,
  referrers,
  sessions,
  events,
  visitors,
  interval,
  teamId,
  siteId,
  wsBaseUrl,
  wsToken,
  locale,
  labels,
}: DashboardClientProps) {
  const [activeMetric, setActiveMetric] = useState<MetricKey | undefined>(undefined);
  const chartMetric = activeMetric ? metricToChart[activeMetric] : undefined;

  const sourceItems = useMemo(
    () =>
      referrers.map((item) => ({
        id: item.referrer || "__direct__",
        label: item.referrer || labels.direct,
        value: item.views,
      })),
    [referrers, labels.direct],
  );

  const pageItems = useMemo(
    () =>
      pages.map((item) => ({
        id: item.pathname,
        label: item.pathname || "/",
        value: item.views,
      })),
    [pages],
  );

  const deviceItems = useMemo(
    () => topGroups(events.map((item) => item.deviceType), 8, (value) => value || "unknown"),
    [events],
  );
  const countryItems = useMemo(
    () => topGroups(events.map((item) => item.country), 8, (value) => value || "??"),
    [events],
  );
  const eventTypeItems = useMemo(
    () => topGroups(events.map((item) => item.eventType), 8, (value) => value || "event"),
    [events],
  );

  function handleMetricClick(key: MetricKey) {
    setActiveMetric((prev) => (prev === key ? undefined : key));
  }

  return (
    <div className="grid grid-cols-6 gap-4">
      <div className="col-span-6">
        <OverviewGrid
          views={overview.views}
          sessions={overview.sessions}
          visitors={overview.visitors}
          bounceRate={overview.bounceRate}
          avgDurationMs={overview.avgDurationMs}
          approximateVisitors={overview.approximateVisitors}
          activeMetric={activeMetric}
          onMetricClick={handleMetricClick}
          labels={labels}
        />
      </div>

      <Widget className="col-span-6">
        <WidgetBody className="p-4 pt-2">
          <TrendAreaChart data={trend} activeMetric={chartMetric} interval={interval} />
        </WidgetBody>
      </Widget>

      <Widget className="col-span-6 xl:col-span-2">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-muted-foreground" />
            {labels.topSources || labels.topReferrers}
          </div>
        </WidgetHead>
        <WidgetBody>
          <BreakdownList items={sourceItems} emptyLabel={labels.noEvents || "No data"} />
        </WidgetBody>
      </Widget>

      <Widget className="col-span-6 xl:col-span-2">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Route className="h-4 w-4 text-muted-foreground" />
            {labels.topPages}
          </div>
        </WidgetHead>
        <WidgetBody>
          <BreakdownList items={pageItems} emptyLabel={labels.noEvents || "No data"} />
        </WidgetBody>
        {labels.viewAllPages && (
          <WidgetFooter>
            <Link href={`/${locale}/app/${teamId}/${siteId}/pages`} className="hover:text-foreground transition-colors">
              {labels.viewAllPages} →
            </Link>
          </WidgetFooter>
        )}
      </Widget>

      <Widget className="col-span-6 xl:col-span-2">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            {labels.topDevices}
          </div>
        </WidgetHead>
        <WidgetBody>
          <BreakdownList
            items={deviceItems.map((item) => ({ ...item, label: item.label || "unknown" }))}
            emptyLabel={labels.noEvents || "No data"}
          />
        </WidgetBody>
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            {labels.topEventsBreakdown}
          </div>
        </WidgetHead>
        <WidgetBody>
          <BreakdownList items={eventTypeItems} emptyLabel={labels.noEvents || "No data"} />
        </WidgetBody>
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-muted-foreground" />
            {labels.topCountries}
          </div>
        </WidgetHead>
        <WidgetBody>
          <BreakdownList items={countryItems} emptyLabel={labels.noEvents || "No data"} />
        </WidgetBody>
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {labels.sessionSnapshot}
          </div>
        </WidgetHead>
        <WidgetBody>
          <SessionCompactList sessions={sessions} emptyLabel={labels.noSessions} />
        </WidgetBody>
        {labels.viewAllSessions && (
          <WidgetFooter>
            <Link href={`/${locale}/app/${teamId}/${siteId}/sessions`} className="hover:text-foreground transition-colors">
              {labels.viewAllSessions} →
            </Link>
          </WidgetFooter>
        )}
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            {labels.realtimeStream}
          </div>
        </WidgetHead>
        <WidgetBody>
          <RealtimeEventList
            siteId={siteId}
            wsBaseUrl={wsBaseUrl}
            wsToken={wsToken}
            labels={{
              wsHint: labels.wsHint,
              waitingLive: labels.waitingLive,
            }}
          />
        </WidgetBody>
        {labels.fullRealtimeView && (
          <WidgetFooter>
            <Link href={`/${locale}/app/${teamId}/${siteId}/realtime`} className="hover:text-foreground transition-colors">
              {labels.fullRealtimeView} →
            </Link>
          </WidgetFooter>
        )}
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            {labels.recentEvents}
          </div>
        </WidgetHead>
        <WidgetBody>
          <EventsTable events={events.slice(0, 10)} emptyLabel={labels.noEvents} />
        </WidgetBody>
        {labels.viewAllEvents && (
          <WidgetFooter>
            <Link href={`/${locale}/app/${teamId}/${siteId}/events`} className="hover:text-foreground transition-colors">
              {labels.viewAllEvents} →
            </Link>
          </WidgetFooter>
        )}
      </Widget>

      <Widget className="col-span-6 xl:col-span-3">
        <WidgetHead>
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            {labels.profiles}
          </div>
        </WidgetHead>
        <WidgetBody>
          <VisitorTable visitors={visitors.slice(0, 10)} emptyLabel={labels.noVisitors} />
        </WidgetBody>
        {labels.viewAllProfiles && (
          <WidgetFooter>
            <Link href={`/${locale}/app/${teamId}/${siteId}/profiles`} className="hover:text-foreground transition-colors">
              {labels.viewAllProfiles} →
            </Link>
          </WidgetFooter>
        )}
      </Widget>
    </div>
  );
}

