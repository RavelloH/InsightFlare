"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { SiteBrandIcon } from "@/components/dashboard/site-brand-icon";
import { TrafficPairBarChart } from "@/components/dashboard/site-traffic-charts";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type {
  DashboardInterval,
  TimeWindow,
} from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface SiteOverviewMetrics {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors: boolean;
}

interface TeamDashboardTrendPoint {
  bucket: number;
  timestampMs: number;
  sites: Array<{
    siteId: string;
    views: number;
    visitors: number;
  }>;
}

interface TeamDashboardData {
  sites: Array<{
    id: string;
    overview?: SiteOverviewMetrics;
  }>;
  trend: TeamDashboardTrendPoint[];
}

interface SidebarSiteSummary {
  id: string;
  slug: string;
  name: string;
  domain: string;
  iconPath?: string;
}

interface SidebarSiteDetailsProps {
  locale: Locale;
  teamId: string;
  teamSlug: string;
  activeSiteSlug?: string;
  currentSection?: string;
  sites: SidebarSiteSummary[];
  labels: {
    views: string;
    visitors: string;
  };
  messages: AppMessages;
}

interface SiteTrendPoint {
  timestampMs: number;
  views: number;
  visitors: number;
}

const SIDEBAR_EXPAND_CHART_DELAY_MS = 220;
const SIDEBAR_COLLAPSE_CHART_DELAY_MS = 300;
const SITE_ROW_DETAIL_CLASS =
  "grid min-w-0 max-w-[20rem] flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:translate-x-1 group-data-[collapsible=icon]:opacity-0";

function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
  section?: string,
): string {
  const base = `/${locale}/app/${teamSlug}/${siteSlug}`;
  if (!section) return base;
  return `${base}/${section}`;
}

function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function intervalStepMs(interval: DashboardInterval): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function buildZeroTrend(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): SiteTrendPoint[] {
  const points: SiteTrendPoint[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );
  const hardLimit = 2000;

  for (let index = 0; index < hardLimit && current <= end; index += 1) {
    points.push({
      timestampMs: current,
      views: 0,
      visitors: 0,
    });
    let next = addZonedInterval(current, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalStepMs(window.interval);
    }
    current = next;
  }

  return points;
}

async function fetchTeamDashboard(
  teamId: string,
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
  signal?: AbortSignal,
): Promise<TeamDashboardData> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    const result = handleDemoRequest({
      path: "/api/private/team-dashboard",
      params: {
        teamId,
        from: window.from,
        to: window.to,
        interval: window.interval,
        timeZone: window.timeZone,
      },
    }) as {
      ok: boolean;
      data?: {
        sites?: Array<{ id: string; overview?: SiteOverviewMetrics }>;
        trend?: TeamDashboardTrendPoint[];
      };
    };
    return {
      sites: Array.isArray(result.data?.sites) ? result.data.sites : [],
      trend: Array.isArray(result.data?.trend) ? result.data.trend : [],
    };
  }
  const params = new URLSearchParams({
    teamId,
    from: String(window.from),
    to: String(window.to),
    interval: window.interval,
    timeZone: window.timeZone,
  });
  const response = await fetch(
    `/api/private/team-dashboard?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      signal,
    },
  );
  if (!response.ok) throw new Error("fetch_team_dashboard_failed");
  const payload = (await response.json()) as {
    ok: boolean;
    data?: {
      sites?: Array<{
        id: string;
        overview?: SiteOverviewMetrics;
      }>;
      trend?: TeamDashboardTrendPoint[];
    };
  };
  if (!payload.ok || !payload.data) {
    throw new Error("fetch_team_dashboard_failed");
  }
  return {
    sites: Array.isArray(payload.data.sites) ? payload.data.sites : [],
    trend: Array.isArray(payload.data.trend) ? payload.data.trend : [],
  };
}

export function SidebarSiteDetails({
  locale,
  teamId,
  teamSlug,
  activeSiteSlug,
  currentSection,
  sites,
  labels,
  messages,
}: SidebarSiteDetailsProps) {
  const { state: sidebarState, isMobile } = useSidebar();
  const { window } = useDashboardQuery();
  const [teamTrend, setTeamTrend] = useState<TeamDashboardTrendPoint[]>([]);
  const [chartWindow, setChartWindow] = useState<
    Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">
  >(() => ({
    from: window.from,
    to: window.to,
    interval: window.interval,
    timeZone: window.timeZone,
  }));
  const [shouldRenderCharts, setShouldRenderCharts] = useState(
    isMobile || sidebarState !== "collapsed",
  );

  useEffect(() => {
    if (isMobile) {
      setShouldRenderCharts(true);
      return;
    }

    if (sidebarState === "collapsed") {
      const timeout = setTimeout(() => {
        setShouldRenderCharts(false);
      }, SIDEBAR_COLLAPSE_CHART_DELAY_MS);
      return () => clearTimeout(timeout);
    }

    const timeout = setTimeout(() => {
      setShouldRenderCharts(true);
    }, SIDEBAR_EXPAND_CHART_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [sidebarState, isMobile]);

  useEffect(() => {
    if (!teamId || sites.length === 0) {
      setTeamTrend([]);
      setChartWindow({
        from: window.from,
        to: window.to,
        interval: window.interval,
        timeZone: window.timeZone,
      });
      return;
    }

    if (!shouldRenderCharts) {
      return;
    }

    const controller = new AbortController();
    let active = true;

    fetchTeamDashboard(teamId, window, controller.signal)
      .then((dashboard) => {
        if (!active) return;
        setTeamTrend(dashboard.trend);
        setChartWindow({
          from: window.from,
          to: window.to,
          interval: window.interval,
          timeZone: window.timeZone,
        });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        if (!active) return;
        setTeamTrend([]);
        setChartWindow({
          from: window.from,
          to: window.to,
          interval: window.interval,
          timeZone: window.timeZone,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    teamId,
    sites.length,
    shouldRenderCharts,
    window.from,
    window.to,
    window.interval,
    window.timeZone,
  ]);

  const siteTrendById = useMemo(() => {
    const siteBuckets = new Map<string, Map<number, SiteTrendPoint>>();
    const starts: number[] = [];
    const end = startOfZonedInterval(
      chartWindow.to,
      chartWindow.interval,
      chartWindow.timeZone,
    );
    const hardLimit = 2000;
    let current = startOfZonedInterval(
      chartWindow.from,
      chartWindow.interval,
      chartWindow.timeZone,
    );
    for (let index = 0; index < hardLimit && current <= end; index += 1) {
      starts.push(current);
      let next = addZonedInterval(
        current,
        chartWindow.interval,
        chartWindow.timeZone,
      );
      if (!Number.isFinite(next) || next <= current) {
        next = current + intervalStepMs(chartWindow.interval);
      }
      current = next;
    }

    for (const site of sites) {
      const bucketMap = new Map<number, SiteTrendPoint>();
      for (const start of starts) {
        bucketMap.set(start, {
          timestampMs: start,
          views: 0,
          visitors: 0,
        });
      }
      siteBuckets.set(site.id, bucketMap);
    }

    for (const point of teamTrend) {
      const bucket = startOfZonedInterval(
        Number(point.timestampMs ?? 0),
        chartWindow.interval,
        chartWindow.timeZone,
      );

      for (const sitePoint of point.sites) {
        const bucketMap = siteBuckets.get(sitePoint.siteId);
        if (!bucketMap) continue;
        const existing = bucketMap.get(bucket) ?? {
          timestampMs: bucket,
          views: 0,
          visitors: 0,
        };
        existing.views += safeCount(sitePoint.views);
        existing.visitors += safeCount(sitePoint.visitors);
        bucketMap.set(bucket, existing);
      }
    }

    return Object.fromEntries(
      Array.from(siteBuckets.entries()).map(([siteId, bucketMap]) => [
        siteId,
        Array.from(bucketMap.entries())
          .sort((left, right) => left[0] - right[0])
          .map(([, value]) => value),
      ]),
    ) as Record<string, SiteTrendPoint[]>;
  }, [
    sites,
    teamTrend,
    chartWindow.from,
    chartWindow.to,
    chartWindow.interval,
    chartWindow.timeZone,
  ]);

  const zeroTrend = useMemo(
    () => buildZeroTrend(chartWindow),
    [
      chartWindow.from,
      chartWindow.to,
      chartWindow.interval,
      chartWindow.timeZone,
    ],
  );

  const cards = useMemo(
    () =>
      sites.map((site) => ({
        site,
        trend: siteTrendById[site.id] ?? zeroTrend,
      })),
    [sites, siteTrendById, zeroTrend],
  );

  return (
    <SidebarMenu>
      {cards.map(({ site, trend }) => {
        const isActive = Boolean(
          activeSiteSlug &&
          (site.slug === activeSiteSlug || site.id === activeSiteSlug),
        );

        return (
          <SidebarMenuItem key={site.id}>
            <SidebarMenuButton
              asChild
              isActive={isActive}
              tooltip={site.name}
              className="h-8 rounded-none"
            >
              <Link
                href={buildSitePath(
                  locale,
                  teamSlug,
                  site.slug,
                  isActive ? currentSection : undefined,
                )}
              >
                <SiteBrandIcon
                  siteId={site.id}
                  siteName={site.name}
                  domain={site.domain}
                  iconSrc={site.iconPath}
                  size="sm"
                />
                <div className={SITE_ROW_DETAIL_CLASS}>
                  <div className="min-w-0">
                    <span className="block truncate text-xs">{site.name}</span>
                  </div>
                  <div className="min-w-0">
                    {shouldRenderCharts ? (
                      <TrafficPairBarChart
                        data={trend}
                        locale={locale}
                        timeZone={chartWindow.timeZone}
                        interval={chartWindow.interval}
                        viewsLabel={labels.views}
                        visitorsLabel={labels.visitors}
                        messages={messages}
                        compact
                      />
                    ) : (
                      <div className="h-4 w-full" />
                    )}
                  </div>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
