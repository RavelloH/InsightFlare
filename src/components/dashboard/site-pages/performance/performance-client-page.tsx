import { useCallback, useMemo, useState } from "react";
import { RiSpeedUpLine } from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  PerformanceTrendChart,
  type PerformanceTrendChartLabels,
} from "@/components/dashboard/charts/performance-trend-chart";
import { PageHeading } from "@/components/dashboard/common/page-heading";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchPerformance } from "@/lib/dashboard/client/data/index";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  PerformanceCountrySummary,
  PerformanceRouteSummary,
  PerformanceSummary,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";

import {
  MetricSummaryCard,
  PathPerformanceTable,
  PerformanceHealthMapCard,
  PerformancePanelText,
  PerformanceRail,
  PerformanceTrendLoadingState,
} from "./components";
import {
  alignComparisonTrend,
  buildMetricTrend,
  buildScoreTrend,
  type CountryHealthRow,
  countrySamples,
  countryScore,
  countryStatus,
  countryValue,
  EMPTY_SUMMARY,
  emptyPerformance,
  formatPanelValue,
  METRIC_THRESHOLDS,
  type MetricCardModel,
  metricScore,
  metricStatus,
  panelLabel,
  type PathPerformanceRow,
  PERFORMANCE_PANELS,
  performanceChangeRate,
  type PerformanceClientPageProps,
  type PerformancePanelKey,
  routeSamples,
  routeScore,
  routeStatus,
  routeValue,
  scoreStatus,
  scoreSummary,
} from "./model";
export function PerformanceClientPage({
  locale,
  messages,
  siteId,
}: PerformanceClientPageProps) {
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const [activePanel, setActivePanel] = useState<PerformancePanelKey>("score");
  const comparisonQuery = useDashboardComparisonQuery(timeWindow, filters);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : null),
    [comparisonQuery],
  );
  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [
      "dashboard",
      "performance",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      comparisonQuery?.mode ?? null,
      comparisonQuery?.window.from ?? null,
      comparisonQuery?.window.to ?? null,
      comparisonQuery?.window.interval ?? null,
      comparisonQuery?.window.timeZone ?? null,
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const currentPromise = fetchPerformance(siteId, timeWindow, filters, {
        signal,
      });
      const comparisonPromise = comparisonQuery
        ? fetchPerformance(
            siteId,
            comparisonQuery.window,
            comparisonQuery.filters,
            { signal },
          )
        : Promise.resolve(null);
      const [performanceData, comparisonData] = await Promise.all([
        currentPromise,
        comparisonPromise,
      ]);

      return {
        performanceData,
        comparisonData,
        dataWindow: {
          from: timeWindow.from,
          to: timeWindow.to,
          interval: timeWindow.interval,
          timeZone: timeWindow.timeZone,
        },
        comparisonDataWindow: comparisonQuery
          ? {
              from: comparisonQuery.window.from,
              to: comparisonQuery.window.to,
              interval: comparisonQuery.window.interval,
              timeZone: comparisonQuery.window.timeZone,
            }
          : null,
      };
    },
    placeholderData: keepPreviousData,
    enabled: typeof window !== "undefined",
  });
  const loading = isPending || isPlaceholderData;
  const performanceData =
    data?.performanceData ?? emptyPerformance(timeWindow.interval);
  const comparisonPerformanceData = data?.comparisonData ?? null;
  const dataWindow = data?.dataWindow ?? {
    from: timeWindow.from,
    to: timeWindow.to,
    interval: timeWindow.interval,
    timeZone: timeWindow.timeZone,
  };
  const comparisonDataWindow = data?.comparisonDataWindow ?? null;
  const comparisonLabel = comparisonQuery
    ? dashboardComparisonLabel(messages, comparisonQuery)
    : null;

  const summaryByPanel = useMemo(
    () =>
      new Map<PerformancePanelKey, PerformanceSummary>(
        PERFORMANCE_PANELS.map((key) => [
          key,
          key === "score"
            ? scoreSummary(performanceData)
            : (performanceData.summaries[key] ?? EMPTY_SUMMARY),
        ]),
      ),
    [performanceData],
  );
  const activeSummary = summaryByPanel.get(activePanel) ?? EMPTY_SUMMARY;
  const activeValue = activeSummary.p75 ?? activeSummary.avg;
  const comparisonSummaryByPanel = useMemo(() => {
    if (!comparisonPerformanceData) return null;
    return new Map<PerformancePanelKey, PerformanceSummary>(
      PERFORMANCE_PANELS.map((key) => [
        key,
        key === "score"
          ? scoreSummary(comparisonPerformanceData)
          : (comparisonPerformanceData.summaries[key] ?? EMPTY_SUMMARY),
      ]),
    );
  }, [comparisonPerformanceData]);
  const comparisonSummary = comparisonSummaryByPanel?.get(activePanel) ?? null;
  const comparisonValue = comparisonSummary
    ? (comparisonSummary.p75 ?? comparisonSummary.avg)
    : null;

  const chartPoints = useMemo(
    () =>
      activePanel === "score"
        ? buildScoreTrend(performanceData, dataWindow)
        : buildMetricTrend(performanceData, activePanel, dataWindow),
    [activePanel, dataWindow, performanceData],
  );
  const comparisonChartPoints = useMemo(() => {
    if (!comparisonPerformanceData || !comparisonDataWindow) return [];
    const points =
      activePanel === "score"
        ? buildScoreTrend(comparisonPerformanceData, comparisonDataWindow)
        : buildMetricTrend(
            comparisonPerformanceData,
            activePanel,
            comparisonDataWindow,
          );
    return alignComparisonTrend(chartPoints, points);
  }, [
    activePanel,
    chartPoints,
    comparisonDataWindow,
    comparisonPerformanceData,
  ]);
  const performanceTrendLabels = useMemo<PerformanceTrendChartLabels>(
    () => ({
      p50: messages.performance.p50Label,
      p75: messages.performance.p75Label,
      p95: messages.performance.p95Label,
    }),
    [
      messages.performance.p50Label,
      messages.performance.p75Label,
      messages.performance.p95Label,
    ],
  );
  const formatPerformanceTrendValue = useCallback(
    (value: number | null | undefined) =>
      formatPanelValue(locale, messages, activePanel, value),
    [activePanel, locale, messages],
  );

  const metricCards = useMemo<MetricCardModel[]>(() => {
    return PERFORMANCE_PANELS.map((key) => {
      const summary = summaryByPanel.get(key) ?? EMPTY_SUMMARY;
      const value = summary.p75 ?? summary.avg;
      const score = key === "score" ? value : metricScore(key, value);
      const status =
        key === "score" ? scoreStatus(value) : metricStatus(key, value);
      return {
        key,
        label: panelLabel(messages, key),
        valueLabel: formatPanelValue(locale, messages, key, value),
        value,
        summary,
        status,
        score,
        comparisonValue:
          comparisonSummaryByPanel?.get(key)?.p75 ??
          comparisonSummaryByPanel?.get(key)?.avg ??
          null,
        changeRate: performanceChangeRate(
          value,
          comparisonSummaryByPanel?.get(key)?.p75 ??
            comparisonSummaryByPanel?.get(key)?.avg,
        ),
      };
    });
  }, [comparisonSummaryByPanel, locale, messages, summaryByPanel]);

  const comparisonRouteMap = useMemo(() => {
    const map = new Map<string, PerformanceRouteSummary>();
    for (const route of comparisonPerformanceData?.routes ?? []) {
      map.set(route.pathname || "/", route);
    }
    return map;
  }, [comparisonPerformanceData?.routes]);

  const pathRows = useMemo<PathPerformanceRow[]>(
    () =>
      (performanceData.routes ?? []).map((route) => {
        const value = routeValue(route, activePanel);
        const score = routeScore(route);
        const pathname = route.pathname || "/";
        const comparisonRoute = comparisonRouteMap.get(pathname);
        return {
          key: pathname,
          pathname,
          views: route.views ?? 0,
          samples: routeSamples(route, activePanel),
          value,
          score,
          status: routeStatus(route, activePanel),
          comparisonViews: comparisonRoute?.views ?? 0,
          comparisonSamples: comparisonRoute
            ? routeSamples(comparisonRoute, activePanel)
            : 0,
          comparisonValue: comparisonRoute
            ? routeValue(comparisonRoute, activePanel)
            : null,
          comparisonScore: comparisonRoute ? routeScore(comparisonRoute) : null,
          comparisonStatus: comparisonRoute
            ? routeStatus(comparisonRoute, activePanel)
            : "none",
        };
      }),
    [activePanel, comparisonRouteMap, performanceData.routes],
  );

  const comparisonCountryMap = useMemo(() => {
    const map = new Map<string, PerformanceCountrySummary>();
    for (const country of comparisonPerformanceData?.countries ?? []) {
      const key = String(country.country ?? "")
        .trim()
        .toUpperCase();
      if (key) map.set(key, country);
    }
    return map;
  }, [comparisonPerformanceData?.countries]);

  const countryRows = useMemo<CountryHealthRow[]>(
    () =>
      (performanceData.countries ?? [])
        .map((country) => {
          const value = countryValue(country, activePanel);
          const score =
            activePanel === "score" ? value : metricScore(activePanel, value);
          const normalizedCountry = String(country.country ?? "")
            .trim()
            .toUpperCase();
          const comparisonCountry = comparisonCountryMap.get(normalizedCountry);
          const { label, code } = resolveCountryLabel(
            normalizedCountry,
            locale,
            messages.common.unknown,
          );
          const flagCode = resolveCountryFlagCode(code, locale);
          return {
            key: normalizedCountry,
            country: normalizedCountry,
            label,
            iconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
            views: country.views ?? 0,
            samples: countrySamples(country, activePanel),
            value,
            score,
            status: countryStatus(country, activePanel),
            comparisonViews: comparisonCountry?.views ?? 0,
            comparisonSamples: comparisonCountry
              ? countrySamples(comparisonCountry, activePanel)
              : 0,
            comparisonValue: comparisonCountry
              ? countryValue(comparisonCountry, activePanel)
              : null,
            comparisonScore: comparisonCountry
              ? countryScore(comparisonCountry)
              : null,
            comparisonStatus: comparisonCountry
              ? countryStatus(comparisonCountry, activePanel)
              : "none",
          };
        })
        .filter((country) => country.country.length > 0),
    [
      activePanel,
      comparisonCountryMap,
      locale,
      messages.common.unknown,
      performanceData.countries,
    ],
  );

  const hasContent =
    chartPoints.some((row) => row.samples > 0) ||
    metricCards.some((card) => card.valueLabel !== "--") ||
    pathRows.length > 0 ||
    countryRows.length > 0;
  const showContent = loading || hasContent;

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.performance.title}
        subtitle={messages.performance.subtitle}
      />

      {showContent ? (
        <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <PerformanceRail
            activePanel={activePanel}
            cards={metricCards}
            onSelect={setActivePanel}
            comparisonLabel={comparisonLabel ?? undefined}
            loading={loading}
          />
          <div className="min-w-0">
            <div className="space-y-4">
              <MetricSummaryCard
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                activeSummary={activeSummary}
                activeValue={activeValue}
                comparisonLabel={comparisonLabel ?? undefined}
                comparisonSummary={comparisonSummary}
                comparisonValue={comparisonValue}
                pathCount={pathRows.length}
                comparisonPathCount={
                  comparisonPerformanceData?.routes?.length ?? 0
                }
                loading={loading}
              />
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle className="inline-flex items-center gap-2">
                        <RiSpeedUpLine className="size-4" />
                        {messages.performance.chartTitle}
                      </CardTitle>
                      <PerformancePanelText
                        transitionKey={activePanel}
                        className="text-sm text-muted-foreground"
                      >
                        {panelLabel(messages, activePanel)}
                      </PerformancePanelText>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <AutoResizer className="w-full" duration={0.24}>
                    <AutoTransition
                      initial={false}
                      transitionKey={loading ? "loading" : activePanel}
                      duration={0.22}
                      type="fade"
                      presenceMode="wait"
                      className="w-full"
                    >
                      {loading ? (
                        <div key="loading" className="w-full">
                          <PerformanceTrendLoadingState messages={messages} />
                        </div>
                      ) : (
                        <div key={`chart-${activePanel}`} className="w-full">
                          <PerformanceTrendChart
                            locale={locale}
                            activePanel={activePanel}
                            dataWindow={dataWindow}
                            points={chartPoints}
                            comparisonPoints={comparisonChartPoints}
                            comparisonLabel={comparisonLabel ?? undefined}
                            labels={performanceTrendLabels}
                            metricThresholds={METRIC_THRESHOLDS}
                            formatValue={formatPerformanceTrendValue}
                          />
                        </div>
                      )}
                    </AutoTransition>
                  </AutoResizer>
                </CardContent>
              </Card>
              <PerformanceHealthMapCard
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                countries={countryRows}
                comparisonLabel={comparisonLabel ?? undefined}
                loading={loading}
              />
              <PathPerformanceTable
                locale={locale}
                messages={messages}
                activePanel={activePanel}
                rows={pathRows}
                comparisonLabel={comparisonLabel ?? undefined}
                loading={loading}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[520px] items-center justify-center text-sm text-muted-foreground">
          {messages.common.noData}
        </div>
      )}
    </div>
  );
}
