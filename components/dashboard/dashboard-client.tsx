"use client";

import { useState } from "react";
import { Activity, Clock, Globe, Route } from "lucide-react";
import Link from "next/link";
import { Widget, WidgetHead, WidgetBody, WidgetFooter } from "@/components/widget/widget";
import { SortToggle } from "@/components/widget/sort-toggle";
import { OverviewGrid, type MetricKey } from "@/components/dashboard/overview-grid";
import { TrendAreaChart } from "@/components/charts/trend-area-chart";
import { PagesBarChart } from "@/components/charts/pages-bar-chart";
import { ReferrerBarChart } from "@/components/charts/referrer-bar-chart";
import { SessionCompactList } from "@/components/dashboard/session-compact-list";
import { RealtimeEventList } from "@/components/dashboard/realtime-event-list";
import { Badge } from "@/components/ui/badge";
import type { TrendPoint, OverviewData, PagesData, ReferrersData, SessionsData } from "@/lib/edge-client";

type ChartMetric = "views" | "sessions";

interface DashboardClientProps {
  overview: OverviewData["data"];
  trend: TrendPoint[];
  pages: PagesData["data"];
  referrers: ReferrersData["data"];
  sessions: SessionsData["data"];
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
    sessionSnapshot: string;
    noSessions: string;
    realtimeStream: string;
    wsHint: string;
    waitingLive: string;
    direct: string;
    viewAllPages?: string;
    viewAllSessions?: string;
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

export function DashboardClient({
  overview,
  trend,
  pages,
  referrers,
  sessions,
  teamId,
  siteId,
  wsBaseUrl,
  wsToken,
  locale,
  labels,
}: DashboardClientProps) {
  const [activeMetric, setActiveMetric] = useState<MetricKey | undefined>(undefined);
  const [pageSort, setPageSort] = useState<"views" | "sessions">("views");
  const [refSort, setRefSort] = useState<"views" | "sessions">("views");

  const chartMetric = activeMetric ? metricToChart[activeMetric] : undefined;

  function handleMetricClick(key: MetricKey) {
    setActiveMetric((prev) => (prev === key ? undefined : key));
  }

  return (
    <div className="space-y-4">
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

      <Widget>
        <WidgetBody className="p-4 pt-2">
          <TrendAreaChart data={trend} activeMetric={chartMetric} />
        </WidgetBody>
      </Widget>

      <div className="grid gap-4 lg:grid-cols-2">
        <Widget>
          <WidgetHead>
            <div className="flex items-center gap-2">
              <Route className="h-4 w-4 text-muted-foreground" />
              {labels.topPages}
            </div>
            <SortToggle
              value={pageSort}
              onChange={setPageSort}
              labels={{ views: labels.views, sessions: labels.sessions }}
            />
          </WidgetHead>
          <WidgetBody>
            {pages.length > 0 ? (
              <PagesBarChart data={pages} sortBy={pageSort} />
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">No data</p>
            )}
          </WidgetBody>
          {labels.viewAllPages && (
            <WidgetFooter>
              <Link href={`/${locale}/app/${teamId}/${siteId}/pages`} className="hover:text-foreground transition-colors">
                {labels.viewAllPages} →
              </Link>
            </WidgetFooter>
          )}
        </Widget>

        <Widget>
          <WidgetHead>
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {labels.topReferrers}
            </div>
            <SortToggle
              value={refSort}
              onChange={setRefSort}
              labels={{ views: labels.views, sessions: labels.sessions }}
            />
          </WidgetHead>
          <WidgetBody>
            {referrers.length > 0 ? (
              <ReferrerBarChart data={referrers} sortBy={refSort} directLabel={labels.direct} />
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">No data</p>
            )}
          </WidgetBody>
        </Widget>

        <Widget>
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

        <Widget>
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
      </div>
    </div>
  );
}
