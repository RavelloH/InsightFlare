import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  AnalyticsTimeTooltipProvider,
  AnalyticsTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { SiteBrandIcon } from "@/components/dashboard/site-brand-icon";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  SidebarMenu,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { numberFormat } from "@/lib/dashboard/format";
import {
  buildTeamSiteTrends,
  teamDashboardQueryOptions,
  type TeamDashboardWindow,
  type TeamTrafficPoint,
} from "@/lib/dashboard/team-dashboard-query";
import type { Locale } from "@/lib/i18n/config";
import Link from "@/lib/router";

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
  loading?: boolean;
  loadingLabel: string;
  labels: {
    views: string;
    visitors: string;
  };
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

interface SidebarSiteRowProps {
  locale: Locale;
  teamSlug: string;
  activeSiteSlug?: string;
  currentSection?: string;
  site: SidebarSiteSummary;
  trend: TeamTrafficPoint[];
  dashboardWindow: TeamDashboardWindow;
  viewsLabel: string;
  visitorsLabel: string;
  shouldRenderCharts: boolean;
  metrics?: {
    views: number;
    visitors: number;
  };
  sidebarState: "expanded" | "collapsed";
  isMobile: boolean;
}

const SidebarSiteRow = memo(function SidebarSiteRow({
  locale,
  teamSlug,
  activeSiteSlug,
  currentSection,
  site,
  trend,
  dashboardWindow,
  viewsLabel,
  visitorsLabel,
  shouldRenderCharts,
  metrics,
  sidebarState,
  isMobile,
}: SidebarSiteRowProps) {
  const isActive = Boolean(
    activeSiteSlug &&
    (site.slug === activeSiteSlug || site.id === activeSiteSlug),
  );
  const tooltipContent =
    sidebarState === "collapsed" ? (
      site.name
    ) : (
      <div className="grid min-w-24 gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-background/70">{viewsLabel}</span>
          <span className="font-mono font-medium tabular-nums">
            {metrics ? numberFormat(locale, metrics.views) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-background/70">{visitorsLabel}</span>
          <span className="font-mono font-medium tabular-nums">
            {metrics ? numberFormat(locale, metrics.visitors) : "—"}
          </span>
        </div>
      </div>
    );
  const tooltipKey =
    sidebarState === "collapsed"
      ? `sidebar-site:${site.id}:collapsed`
      : `sidebar-site:${site.id}:expanded:${metrics?.views ?? "pending"}:${metrics?.visitors ?? "pending"}`;

  const siteLink = (
    <SidebarMenuButton asChild isActive={isActive} className="h-8 rounded-none">
      <Link href={buildSitePath(locale, teamSlug, site.slug, currentSection)}>
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
                timeZone={dashboardWindow.timeZone}
                interval={dashboardWindow.interval}
                viewsLabel={viewsLabel}
                visitorsLabel={visitorsLabel}
                compact
                dataIsComplete
              />
            ) : (
              <div className="h-4 w-full" />
            )}
          </div>
        </div>
      </Link>
    </SidebarMenuButton>
  );

  return isMobile ? (
    siteLink
  ) : (
    <AnalyticsTooltipTarget
      className="block"
      request={{ key: tooltipKey, content: tooltipContent }}
    >
      {siteLink}
    </AnalyticsTooltipTarget>
  );
});

export const SidebarSiteDetails = memo(function SidebarSiteDetails({
  locale,
  teamId,
  teamSlug,
  activeSiteSlug,
  currentSection,
  sites,
  loading = false,
  loadingLabel,
  labels,
}: SidebarSiteDetailsProps) {
  const { state: sidebarState, isMobile } = useSidebar();
  const { window } = useDashboardQuery();
  const [shouldRenderCharts, setShouldRenderCharts] = useState(
    isMobile || sidebarState !== "collapsed",
  );
  const teamDashboardQuery = useQuery(
    teamDashboardQueryOptions({
      teamId,
      window,
      range: window.preset,
      enabled: Boolean(teamId) && sites.length > 0 && shouldRenderCharts,
    }),
  );
  const dashboardSnapshot = teamDashboardQuery.data;
  const dashboardWindow = dashboardSnapshot?.window ?? window;

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

  const siteTrendById = useMemo(() => {
    return buildTeamSiteTrends(
      sites.map((site) => site.id),
      dashboardSnapshot?.data.trend ?? [],
      dashboardWindow,
    );
  }, [dashboardSnapshot?.data.trend, dashboardWindow, sites]);

  const siteMetricsById = useMemo(
    () =>
      new Map(
        (dashboardSnapshot?.data.sites ?? []).map((site) => [
          site.id,
          {
            views: site.overview.views,
            visitors: site.overview.visitors,
          },
        ]),
      ),
    [dashboardSnapshot?.data.sites],
  );

  const cards = useMemo(
    () =>
      sites.map((site) => ({
        site,
        trend: siteTrendById[site.id] ?? [],
      })),
    [sites, siteTrendById],
  );

  const menu = (
    <SidebarMenu aria-busy={loading}>
      <AutoTransition
        as="li"
        initial={false}
        transitionKey={loading ? "loading" : "sites"}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        aria-hidden={loading ? undefined : cards.length === 0}
        className="group/menu-item relative"
      >
        {loading ? (
          <div role="status" aria-live="polite">
            <SidebarMenuButton type="button" disabled aria-label={loadingLabel}>
              <Spinner aria-hidden="true" />
              <span>{loadingLabel}</span>
            </SidebarMenuButton>
          </div>
        ) : (
          <div className="flex w-full min-w-0 flex-col gap-1">
            {cards.map(({ site, trend }) => {
              return (
                <SidebarSiteRow
                  key={site.id}
                  locale={locale}
                  teamSlug={teamSlug}
                  activeSiteSlug={activeSiteSlug}
                  currentSection={currentSection}
                  site={site}
                  trend={trend}
                  dashboardWindow={dashboardWindow}
                  viewsLabel={labels.views}
                  visitorsLabel={labels.visitors}
                  shouldRenderCharts={shouldRenderCharts}
                  metrics={siteMetricsById.get(site.id)}
                  sidebarState={sidebarState}
                  isMobile={isMobile}
                />
              );
            })}
          </div>
        )}
      </AutoTransition>
    </SidebarMenu>
  );

  return isMobile ? (
    menu
  ) : (
    <AnalyticsTimeTooltipProvider retentionMode="target">
      {menu}
    </AnalyticsTimeTooltipProvider>
  );
});
