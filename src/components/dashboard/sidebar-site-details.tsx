import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { SiteBrandIcon } from "@/components/dashboard/site-brand-icon";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  buildTeamSiteTrends,
  teamDashboardQueryOptions,
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

export function SidebarSiteDetails({
  locale,
  teamId,
  teamSlug,
  activeSiteSlug,
  currentSection,
  sites,
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

  const cards = useMemo(
    () =>
      sites.map((site) => ({
        site,
        trend: siteTrendById[site.id] ?? [],
      })),
    [sites, siteTrendById],
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
                  currentSection,
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
                        timeZone={dashboardWindow.timeZone}
                        interval={dashboardWindow.interval}
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
