"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TrafficPairBarChart } from "@/components/dashboard/site-traffic-charts";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { AutoTransition } from "@/components/ui/auto-transition";
import type { DashboardInterval, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

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
}

interface SidebarSiteDetailsProps {
  locale: Locale;
  teamId: string;
  teamSlug: string;
  activeSiteSlug?: string;
  sites: SidebarSiteSummary[];
  labels: {
    views: string;
    visitors: string;
  };
}

interface SiteTrendPoint {
  timestampMs: number;
  views: number;
  visitors: number;
}

interface SiteIconProps {
  siteName: string;
  domain: string;
}

const SIDEBAR_EXPAND_CHART_DELAY_MS = 220;
const SIDEBAR_ROUTE_SETTLE_DELAY_MS = 360;

function buildSitePath(locale: Locale, teamSlug: string, siteSlug: string): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}

function resolveFaviconUrl(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLetter(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function SiteIcon({ siteName, domain }: SiteIconProps) {
  const src = useMemo(() => resolveFaviconUrl(domain), [domain]);
  const [iconLoaded, setIconLoaded] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconLoaded(false);
    setIconFailed(false);

    if (!src) return;

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setIconLoaded(true);
    };
    image.onerror = () => {
      if (!active) return;
      setIconFailed(true);
    };
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  const showFavicon = Boolean(src) && iconLoaded && !iconFailed;

  return (
    <AutoTransition
      type="fade"
      duration={0.18}
      initial={false}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {showFavicon ? (
        <img key="favicon" src={src!} alt="" className="size-4 shrink-0" />
      ) : (
        <span
          key="fallback"
          className="inline-flex size-4 shrink-0 items-center justify-center bg-muted text-[10px] font-medium text-muted-foreground"
        >
          {leadingLetter(siteName)}
        </span>
      )}
    </AutoTransition>
  );
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

function buildZeroTrend(window: Pick<TimeWindow, "from" | "to" | "interval">): SiteTrendPoint[] {
  const stepMs = intervalStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) return [];

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const points: SiteTrendPoint[] = [];

  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    points.push({
      timestampMs: bucket * stepMs,
      views: 0,
      visitors: 0,
    });
  }

  return points;
}

async function fetchTeamDashboard(
  teamId: string,
  window: Pick<TimeWindow, "from" | "to" | "interval">,
  signal?: AbortSignal,
): Promise<TeamDashboardData> {
  const params = new URLSearchParams({
    teamId,
    from: String(window.from),
    to: String(window.to),
    interval: window.interval,
  });
  const response = await fetch(`/api/private/team-dashboard?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    signal,
  });
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
  sites,
  labels,
}: SidebarSiteDetailsProps) {
  const pathname = usePathname();
  const { state: sidebarState, isMobile } = useSidebar();
  const { window } = useDashboardQuery();
  const [teamTrend, setTeamTrend] = useState<TeamDashboardTrendPoint[]>([]);
  const [chartWindow, setChartWindow] = useState<
    Pick<TimeWindow, "from" | "to" | "interval">
  >(() => ({
    from: window.from,
    to: window.to,
    interval: window.interval,
  }));
  const [shouldRenderCharts, setShouldRenderCharts] = useState(
    isMobile || sidebarState !== "collapsed",
  );
  const [isRouteSettled, setIsRouteSettled] = useState(true);
  const didMountRef = useRef(false);

  useEffect(() => {
    if (isMobile) {
      setShouldRenderCharts(true);
      return;
    }

    if (sidebarState === "collapsed") {
      setShouldRenderCharts(false);
      return;
    }

    const timeout = setTimeout(() => {
      setShouldRenderCharts(true);
    }, SIDEBAR_EXPAND_CHART_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [sidebarState, isMobile]);

  useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    setTeamTrend([]);
    setIsRouteSettled(false);

    const timeout = setTimeout(() => {
      setIsRouteSettled(true);
    }, SIDEBAR_ROUTE_SETTLE_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [pathname]);

  const canFetchCharts = shouldRenderCharts && isRouteSettled;

  useEffect(() => {
    if (!teamId || sites.length === 0) {
      setTeamTrend([]);
      setChartWindow({
        from: window.from,
        to: window.to,
        interval: window.interval,
      });
      return;
    }

    if (!canFetchCharts) {
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
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [teamId, sites.length, canFetchCharts, window.from, window.to, window.interval]);

  const siteTrendById = useMemo(() => {
    const stepMs = intervalStepMs(chartWindow.interval);
    if (!Number.isFinite(stepMs) || stepMs <= 0) {
      return {} as Record<string, SiteTrendPoint[]>;
    }

    const fromBucket = Math.floor(chartWindow.from / stepMs);
    const toBucket = Math.max(fromBucket, Math.floor(chartWindow.to / stepMs));
    const siteBuckets = new Map<string, Map<number, SiteTrendPoint>>();

    for (const site of sites) {
      const bucketMap = new Map<number, SiteTrendPoint>();
      for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
        bucketMap.set(bucket, {
          timestampMs: bucket * stepMs,
          views: 0,
          visitors: 0,
        });
      }
      siteBuckets.set(site.id, bucketMap);
    }

    for (const point of teamTrend) {
      const bucket =
        Number.isFinite(point.bucket) && point.bucket >= 0
          ? point.bucket
          : Math.floor(point.timestampMs / stepMs);

      for (const sitePoint of point.sites) {
        const bucketMap = siteBuckets.get(sitePoint.siteId);
        if (!bucketMap) continue;
        const existing = bucketMap.get(bucket) ?? {
          timestampMs: point.timestampMs || bucket * stepMs,
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
  ]);

  const zeroTrend = useMemo(
    () => buildZeroTrend(chartWindow),
    [chartWindow.from, chartWindow.to, chartWindow.interval],
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
          activeSiteSlug && (site.slug === activeSiteSlug || site.id === activeSiteSlug),
        );

        return (
          <SidebarMenuItem key={site.id}>
            <SidebarMenuButton
              asChild
              isActive={isActive}
              tooltip={site.name}
              className="h-8 rounded-none"
            >
              <Link href={buildSitePath(locale, teamSlug, site.slug)}>
                <SiteIcon siteName={site.name} domain={site.domain} />
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 group-data-[collapsible=icon]:hidden">
                  <div className="min-w-0">
                    <span className="block truncate text-xs">{site.name}</span>
                  </div>
                  <div className="min-w-0">
                    {shouldRenderCharts ? (
                      <TrafficPairBarChart
                        data={trend}
                        locale={locale}
                        interval={chartWindow.interval}
                        viewsLabel={labels.views}
                        visitorsLabel={labels.visitors}
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
