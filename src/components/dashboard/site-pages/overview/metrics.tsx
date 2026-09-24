import { useMemo } from "react";
import { RiLineChartLine } from "@remixicon/react";

import { MetricAreaChart } from "@/components/dashboard/charts/metric-area-chart";
import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";

import {
  buildOverviewMetricSeries,
  comparisonLabelForQuery,
  useOverviewComparisonQuery,
  useOverviewSummaryQuery,
} from "./metrics-data";
import {
  buildEmptyTrendData,
  ChangeRateInline,
  COMPARISON_AREA_COLOR,
  EMPTY_TREND_POINTS,
  emptyOverviewData,
  emptyTrendData,
  METRIC_AREA_COLOR,
  metricCellBorderClasses,
  normalizeTrendData,
  toDeltaPercent,
} from "./overview-model";
import { type OverviewDataSectionProps } from "./types";
export function OverviewMetricsSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const comparisonQuery = useOverviewComparisonQuery(window, filters);
  const {
    data: metricsData,
    isFetching,
    isPending,
  } = useOverviewSummaryQuery({
    siteId,
    window,
    filters,
    comparisonQuery,
  });
  const loading = isPending || isFetching;
  const overview = metricsData?.overview ?? emptyOverviewData();
  const previousOverview = metricsData?.previousOverview ?? emptyOverviewData();
  const detailSeries = metricsData?.trendData.data ?? EMPTY_TREND_POINTS;
  const comparisonOverview = metricsData?.comparisonOverview;
  const comparisonDetailSeries =
    metricsData?.comparisonTrendData?.data ?? EMPTY_TREND_POINTS;

  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );
  const previous = previousOverview.data;
  const currentPagesPerSession =
    overview.data.sessions > 0
      ? overview.data.views / overview.data.sessions
      : 0;
  const previousPagesPerSession =
    previous.sessions > 0 ? previous.views / previous.sessions : 0;

  const metricSeries = useMemo(
    () => buildOverviewMetricSeries(detailSeries),
    [detailSeries],
  );
  const comparisonMetricSeries = useMemo(
    () => buildOverviewMetricSeries(comparisonDetailSeries),
    [comparisonDetailSeries],
  );
  const comparison = comparisonOverview?.data ?? emptyOverviewData().data;
  const comparisonPagesPerSession =
    comparison.sessions > 0 ? comparison.views / comparison.sessions : 0;
  const metricChartAnimationKey = useMemo(() => {
    const firstTimestamp = detailSeries[0]?.timestampMs ?? 0;
    const lastTimestamp =
      detailSeries[detailSeries.length - 1]?.timestampMs ?? 0;
    const comparisonFirstTimestamp =
      comparisonDetailSeries[0]?.timestampMs ?? 0;
    const comparisonLastTimestamp =
      comparisonDetailSeries[comparisonDetailSeries.length - 1]?.timestampMs ??
      0;
    return `${detailSeries.length}:${firstTimestamp}:${lastTimestamp}:${comparisonQuery?.mode ?? "none"}:${comparisonDetailSeries.length}:${comparisonFirstTimestamp}:${comparisonLastTimestamp}`;
  }, [comparisonDetailSeries, comparisonQuery?.mode, detailSeries]);
  const comparisonLabel = comparisonLabelForQuery(messages, comparisonQuery);
  const hasComparisonData = Boolean(
    comparisonQuery &&
    metricsData?.comparisonOverview &&
    metricsData.comparisonTrendData,
  );
  const reference = comparisonQuery ? comparison : previous;
  const referencePagesPerSession = comparisonQuery
    ? comparisonPagesPerSession
    : previousPagesPerSession;

  const metrics = useMemo(
    () => [
      {
        key: "views" as const,
        label: messages.common.views,
        value: numberFormat(locale, overview.data.views),
        delta: toDeltaPercent(overview.data.views, reference.views),
        trend: metricSeries.views,
        comparisonTrend: comparisonMetricSeries.views,
        formatTrendValue: (value: number) =>
          numberFormat(locale, Math.round(value)),
      },
      {
        key: "visitors" as const,
        label: messages.common.visitors,
        value: numberFormat(locale, overview.data.visitors),
        delta: toDeltaPercent(overview.data.visitors, reference.visitors),
        trend: metricSeries.visitors,
        comparisonTrend: comparisonMetricSeries.visitors,
        formatTrendValue: (value: number) =>
          numberFormat(locale, Math.round(value)),
      },
      {
        key: "sessions" as const,
        label: messages.common.sessions,
        value: numberFormat(locale, overview.data.sessions),
        delta: toDeltaPercent(overview.data.sessions, reference.sessions),
        trend: metricSeries.sessions,
        comparisonTrend: comparisonMetricSeries.sessions,
        formatTrendValue: (value: number) =>
          numberFormat(locale, Math.round(value)),
      },
      {
        key: "bounceRate" as const,
        label: messages.common.bounceRate,
        value: percentFormat(locale, overview.data.bounceRate),
        delta: toDeltaPercent(overview.data.bounceRate, reference.bounceRate),
        lowerIsBetter: true,
        trend: metricSeries.bounceRate,
        comparisonTrend: comparisonMetricSeries.bounceRate,
        formatTrendValue: (value: number) => percentFormat(locale, value),
      },
      {
        key: "pagesPerSession" as const,
        label: messages.teamManagement.sites.pagesPerSession,
        value: pagesPerSessionFormatter.format(currentPagesPerSession),
        delta: toDeltaPercent(currentPagesPerSession, referencePagesPerSession),
        trend: metricSeries.pagesPerSession,
        comparisonTrend: comparisonMetricSeries.pagesPerSession,
        formatTrendValue: (value: number) =>
          pagesPerSessionFormatter.format(value),
      },
      {
        key: "avgDuration" as const,
        label: messages.common.avgDuration,
        value: durationFormat(locale, overview.data.avgDurationMs),
        delta: toDeltaPercent(
          overview.data.avgDurationMs,
          reference.avgDurationMs,
        ),
        trend: metricSeries.avgDuration,
        comparisonTrend: comparisonMetricSeries.avgDuration,
        formatTrendValue: (value: number) =>
          durationFormat(locale, Math.max(0, Math.round(value))),
      },
    ],
    [
      currentPagesPerSession,
      comparisonMetricSeries,
      locale,
      messages.common.avgDuration,
      messages.common.bounceRate,
      messages.common.sessions,
      messages.common.views,
      messages.common.visitors,
      messages.teamManagement.sites.pagesPerSession,
      metricSeries,
      overview.data.avgDurationMs,
      overview.data.bounceRate,
      overview.data.sessions,
      overview.data.visitors,
      overview.data.views,
      pagesPerSessionFormatter,
      reference.avgDurationMs,
      reference.bounceRate,
      reference.sessions,
      reference.visitors,
      reference.views,
      referencePagesPerSession,
    ],
  );

  return (
    <Card className="gap-0 py-0">
      <CardContent className="px-0">
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {metrics.map((item, index) => {
            const hasDelta =
              typeof item.delta === "number" && Number.isFinite(item.delta);
            const effectiveDelta = hasDelta ? (item.delta ?? 0) : null;
            const comparisonPoints = hasComparisonData
              ? item.comparisonTrend
              : undefined;

            return (
              <div key={item.label} className={metricCellBorderClasses(index)}>
                <div className="relative min-h-[74px]">
                  <div className="absolute inset-y-0 right-0 w-1/2 min-w-0">
                    <MetricAreaChart
                      points={item.trend}
                      color={METRIC_AREA_COLOR}
                      locale={locale}
                      timeZone={window.timeZone}
                      interval={window.interval}
                      label={item.label}
                      formatValue={item.formatTrendValue}
                      animationKey={metricChartAnimationKey}
                      comparisonPoints={comparisonPoints}
                      comparisonColor={COMPARISON_AREA_COLOR}
                      comparisonLabel={comparisonLabel}
                    />
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-h-[74px] min-w-0 flex-col justify-between px-3 py-2.5">
                    <p className="truncate text-xs text-muted-foreground mb-4">
                      {item.label}
                    </p>
                    <div>
                      <AutoResizer initial>
                        <AutoTransition initial>
                          {loading ? (
                            <div
                              key="loading"
                              className="inline-flex h-6 items-center"
                            >
                              <Spinner className="size-5" />
                            </div>
                          ) : (
                            <p
                              key="value"
                              className="inline-flex h-6 items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                            >
                              <span>{item.value}</span>
                              <ChangeRateInline
                                value={effectiveDelta}
                                lowerIsBetter={item.lowerIsBetter}
                              />
                            </p>
                          )}
                        </AutoTransition>
                      </AutoResizer>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
  );
}
export function OverviewTrendSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const comparisonQuery = useOverviewComparisonQuery(window, filters);
  const currentDataWindow = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.timeZone, window.to],
  );
  const {
    data: trendQueryData,
    isFetching,
    isPending,
  } = useOverviewSummaryQuery({
    siteId,
    window,
    filters,
    comparisonQuery,
  });
  const loading = isPending || isFetching;
  const trendData =
    trendQueryData?.trendData ?? emptyTrendData(window.interval);
  const dataWindow = trendQueryData?.dataWindow ?? currentDataWindow;
  const hasTrendData = Boolean(trendQueryData);

  const trendDisplayData = useMemo(() => {
    if (!hasTrendData && isPending) {
      return buildEmptyTrendData(dataWindow);
    }
    return normalizeTrendData(dataWindow, trendData.data);
  }, [
    dataWindow.from,
    dataWindow.interval,
    dataWindow.timeZone,
    dataWindow.to,
    hasTrendData,
    isPending,
    trendData.data,
  ]);
  const comparisonTrendDisplayData = useMemo(() => {
    if (!comparisonQuery || !trendQueryData?.comparisonTrendData) {
      return undefined;
    }
    return normalizeTrendData(
      comparisonQuery.window,
      trendQueryData.comparisonTrendData.data,
    );
  }, [comparisonQuery, trendQueryData?.comparisonTrendData]);
  const comparisonLabel = comparisonLabelForQuery(messages, comparisonQuery);
  return (
    <Card className="overflow-visible">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="inline-flex items-center gap-2">
          <RiLineChartLine className="size-4" />
          {messages.overview.trendTitle}
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {messages.common.lastUpdated}:{" "}
          {shortDateTime(locale, Date.now(), dataWindow.timeZone)}
        </span>
      </CardHeader>
      <CardContent>
        <div>
          <TrafficPairBarChart
            data={trendDisplayData}
            locale={locale}
            timeZone={dataWindow.timeZone}
            interval={dataWindow.interval}
            viewsLabel={messages.common.views}
            visitorsLabel={messages.common.visitors}
            axisDateFormat="regular"
            showLegend
            loading={loading}
            className="h-[280px]"
            range={comparisonQuery ? window : undefined}
            comparisonData={comparisonTrendDisplayData}
            comparisonRange={comparisonQuery?.window}
            currentPeriodLabel={messages.dashboardHeader.compareCurrentPeriod}
            comparisonLabel={comparisonLabel}
          />
        </div>
      </CardContent>
    </Card>
  );
}
