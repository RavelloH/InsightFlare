import { type ReactNode, useEffect, useRef, useState } from "react";
import { SiteTrafficStackChart } from "@insightflare/product-ui/charts";
import { TrafficPairBarChart } from "@insightflare/product-ui/charts";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Skeleton } from "@insightflare/ui/skeleton";
import { Spinner } from "@insightflare/ui/spinner";
import {
  RiArrowDownLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiBarChartBoxLine,
} from "@remixicon/react";

import { SiteBrandIcon } from "@/components/dashboard/common/site-brand-icon";
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

function DeferredSiteChart({
  children,
  loadingLabel,
}: {
  children: ReactNode;
  loadingLabel: string;
}) {
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
    <div ref={containerRef} className="relative h-[180px] w-full">
      {ready ? (
        children
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Spinner className="size-5" aria-label={loadingLabel} />
        </div>
      )}
    </div>
  );
}

function SiteMetricValue({
  pending,
  unavailable,
  children,
  loadingLabel,
}: {
  pending: boolean;
  unavailable: boolean;
  children: ReactNode;
  loadingLabel: string;
}) {
  return (
    <div className="h-4">
      <AutoTransition
        as="span"
        initial={false}
        duration={0.2}
        transitionKey={
          pending ? "loading" : unavailable ? "unavailable" : "ready"
        }
        className="inline-flex h-4 items-end gap-1.5 font-mono text-base leading-none"
      >
        {pending ? (
          <Spinner className="size-4" aria-label={loadingLabel} />
        ) : unavailable ? (
          "—"
        ) : (
          children
        )}
      </AutoTransition>
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
    dashboardMetricsPending,
    dashboardMetricsUnavailable,
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
              periodTotals={dashboardSites.map((site) => ({
                siteId: site.id,
                views: site.overview.views,
                visitors: site.overview.visitors,
              }))}
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
              loading={dashboardMetricsPending || dashboardQuery.isFetching}
              metricsPending={dashboardMetricsPending}
              metricsUnavailable={dashboardMetricsUnavailable}
            />
          </div>

          {!dashboardMetricsPending &&
          !dashboardMetricsUnavailable &&
          dashboardSites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {copy.sites.noSites}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {siteDashboardCards.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* These are anonymous chart slots before the analytics result
              determines the site order. Keep initialized charts at their
              visual positions rather than moving them out of the viewport. */}
          {siteDashboardCards.map(
            (
              { site, overview, pagesPerSession, changeRates, trend },
              index,
            ) => (
              <Link
                key={index}
                href={buildSitePath(locale, activeTeam.slug, site.slug)}
                className="group block h-full cursor-pointer outline-none transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:ring-1 focus-visible:ring-ring/60"
                aria-label={`${copy.sites.openAnalytics}: ${site.name}`}
              >
                <Card className="h-full transition-colors group-hover:bg-accent/20">
                  <CardHeader className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <div className="min-w-0 space-y-1">
                          <CardTitle className="flex h-6 items-center gap-2 truncate text-base">
                            <AutoTransition
                              initial={false}
                              transitionKey={
                                dashboardMetricsPending ? "loading" : site.id
                              }
                              duration={0.2}
                              className="flex h-6 min-w-0 items-center gap-2"
                            >
                              {dashboardMetricsPending ? (
                                <>
                                  <Skeleton className="size-5 shrink-0" />
                                  <Skeleton className="h-4 w-28 max-w-full" />
                                </>
                              ) : (
                                <>
                                  <SiteBrandIcon
                                    key={site.id}
                                    siteId={site.id}
                                    siteName={site.name}
                                    domain={site.domain}
                                    iconSrc={site.iconPath}
                                    size="md"
                                  />
                                  <span className="truncate">{site.name}</span>
                                </>
                              )}
                            </AutoTransition>
                          </CardTitle>
                          <CardDescription className="flex h-[1.21875rem] items-center truncate font-mono text-xs">
                            <AutoTransition
                              initial={false}
                              transitionKey={
                                dashboardMetricsPending ? "loading" : site.id
                              }
                              duration={0.2}
                              className="flex h-full min-w-0 items-center"
                            >
                              {dashboardMetricsPending ? (
                                <Skeleton className="h-3 w-36 max-w-full" />
                              ) : (
                                <span className="truncate">{site.domain}</span>
                              )}
                            </AutoTransition>
                          </CardDescription>
                        </div>
                      </div>
                      <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                        <RiArrowRightSLine className="size-4" />
                      </span>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <DeferredSiteChart loadingLabel={messages.common.loading}>
                      <TrafficPairBarChart
                        data={trend}
                        locale={locale}
                        timeZone={dashboardWindow.timeZone}
                        interval={dashboardWindow.interval}
                        viewsLabel={messages.common.views}
                        visitorsLabel={messages.common.visitors}
                        axisDateFormat="compact"
                        maxPoints={SITE_CARD_MAX_TREND_POINTS}
                        loading={
                          dashboardMetricsPending || dashboardQuery.isFetching
                        }
                        range={dashboardWindow}
                      />
                    </DeferredSiteChart>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-[11px] sm:grid-cols-3">
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.views}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {numberFormat(locale, overview.views)}
                          <ChangeRateInline value={changeRates.views} />
                        </SiteMetricValue>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.visitors}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {numberFormat(locale, overview.visitors)}
                          <ChangeRateInline value={changeRates.visitors} />
                        </SiteMetricValue>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.sessions}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {numberFormat(locale, overview.sessions)}
                          <ChangeRateInline value={changeRates.sessions} />
                        </SiteMetricValue>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.bounceRate}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {percentFormat(locale, overview.bounceRate)}
                          <ChangeRateInline
                            value={changeRates.bounceRate}
                            lowerIsBetter
                          />
                        </SiteMetricValue>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {copy.sites.pagesPerSession}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {pagesPerSessionFormatter.format(pagesPerSession)}
                          <ChangeRateInline
                            value={changeRates.pagesPerSession}
                          />
                        </SiteMetricValue>
                      </div>
                      <div className="space-y-1">
                        <p className="text-muted-foreground">
                          {messages.common.avgDuration}
                        </p>
                        <SiteMetricValue
                          pending={dashboardMetricsPending}
                          unavailable={dashboardMetricsUnavailable}
                          loadingLabel={messages.common.loading}
                        >
                          {durationFormat(locale, overview.avgDurationMs)}
                          <ChangeRateInline value={changeRates.avgDurationMs} />
                        </SiteMetricValue>
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
