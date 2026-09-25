import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  RiArrowDownLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiBarChartBoxLine,
} from "@remixicon/react";

import { SiteTrafficStackChart } from "@/components/dashboard/charts/site-traffic-stack-chart";
import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { SiteBrandIcon } from "@/components/dashboard/common/site-brand-icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import Link from "@/lib/router";

import { useTeamManagementContext } from "./context";
import {
  buildSitePath,
  changeRateClass,
  formatChangeRate,
  SITE_CARD_MAX_TREND_POINTS,
} from "./model";

function DeferredSiteChart({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setReady(true);
        observer.disconnect();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="h-[180px] w-full">
      {ready ? children : null}
    </div>
  );
}

export function TeamManagementSitesPanel() {
  const {
    activeTab,
    activeTeam,
    aggregateChartRenderData,
    aggregateChartSites,
    copy,
    dashboardQuery,
    dashboardSites,
    dashboardWindow,
    locale,
    messages,
    pagesPerSessionFormatter,
    siteDashboardCards,
  } = useTeamManagementContext();

  function ChangeRateInline({
    value,
    lowerIsBetter = false,
  }: {
    value: number | null;
    lowerIsBetter?: boolean;
  }) {
    if (value === null) return null;
    const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
    return (
      <span
        className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value, lowerIsBetter)}`}
      >
        <Icon className="size-3.5" />
        {formatChangeRate(value)}
      </span>
    );
  }

  return activeTab === "sites" ? (
    <div className="space-y-4">
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiBarChartBoxLine className="size-4" />
            {copy.sites.aggregateTitle}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3">
          <div>
            <SiteTrafficStackChart
              data={aggregateChartRenderData}
              sites={aggregateChartSites}
              from={dashboardWindow.from}
              to={dashboardWindow.to}
              locale={locale}
              timeZone={dashboardWindow.timeZone}
              interval={dashboardWindow.interval}
              viewsLabel={messages.common.views}
              visitorsLabel={messages.common.visitors}
              messages={messages}
              axisDateFormat="regular"
              loading={dashboardQuery.isFetching}
            />
          </div>

          {!dashboardQuery.isPending && dashboardSites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {copy.sites.noSites}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {siteDashboardCards.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {siteDashboardCards.map(
            ({ site, overview, pagesPerSession, changeRates, trend }) => (
              <Link
                key={site.id}
                href={buildSitePath(locale, activeTeam.slug, site.slug)}
                className="group block h-full cursor-pointer outline-none transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:ring-1 focus-visible:ring-ring/60"
                aria-label={`${copy.sites.openAnalytics}: ${site.name}`}
              >
                <Card className="h-full transition-colors group-hover:bg-accent/20">
                  <CardHeader className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div className="min-w-0 space-y-1">
                          <CardTitle className="flex items-center gap-2 truncate text-base">
                            <SiteBrandIcon
                              siteId={site.id}
                              siteName={site.name}
                              domain={site.domain}
                              iconSrc={site.iconPath}
                              size="md"
                            />
                            {site.name}
                          </CardTitle>
                          <CardDescription className="truncate font-mono text-xs">
                            {site.domain}
                          </CardDescription>
                        </div>
                      </div>
                      <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                        <RiArrowRightSLine className="size-4" />
                      </span>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <DeferredSiteChart>
                      <TrafficPairBarChart
                        data={trend}
                        locale={locale}
                        timeZone={dashboardWindow.timeZone}
                        interval={dashboardWindow.interval}
                        viewsLabel={messages.common.views}
                        visitorsLabel={messages.common.visitors}
                        axisDateFormat="compact"
                        maxPoints={SITE_CARD_MAX_TREND_POINTS}
                        loading={dashboardQuery.isFetching}
                        range={dashboardWindow}
                      />
                    </DeferredSiteChart>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-[11px] sm:grid-cols-3">
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.views}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {numberFormat(locale, overview.views)}
                          <ChangeRateInline value={changeRates.views} />
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.visitors}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {numberFormat(locale, overview.visitors)}
                          <ChangeRateInline value={changeRates.visitors} />
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.sessions}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {numberFormat(locale, overview.sessions)}
                          <ChangeRateInline value={changeRates.sessions} />
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.bounceRate}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {percentFormat(locale, overview.bounceRate)}
                          <ChangeRateInline
                            value={changeRates.bounceRate}
                            lowerIsBetter
                          />
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {copy.sites.pagesPerSession}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {pagesPerSessionFormatter.format(pagesPerSession)}
                          <ChangeRateInline
                            value={changeRates.pagesPerSession}
                          />
                        </p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.avgDuration}
                        </p>
                        <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                          {durationFormat(locale, overview.avgDurationMs)}
                          <ChangeRateInline value={changeRates.avgDurationMs} />
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ),
          )}
        </div>
      ) : null}
    </div>
  ) : null;
}
