import { useMemo } from "react";
import { TrafficPairBarChart } from "@insightflare/product-ui/charts";
import {
  type OverviewMetricKey,
  OverviewMetricsView,
  type OverviewMetricsViewItem,
} from "@insightflare/product-ui/overview";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiLineChartLine } from "@remixicon/react";

import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import { buildOverviewMetricsLabels } from "@/lib/product-ui-labels/overview";

import {
  buildOverviewMetricSeries,
  comparisonLabelForQuery,
  useOverviewComparisonQuery,
  useOverviewSummaryQuery,
} from "./metrics-data";
import {
  buildEmptyTrendData,
  EMPTY_TREND_POINTS,
  emptyOverviewData,
  emptyTrendData,
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

  const labels = useMemo(
    () => buildOverviewMetricsLabels(messages),
    [messages],
  );
  const items = useMemo<OverviewMetricsViewItem[]>(() => {
    const comparisonTrend = (key: OverviewMetricKey) =>
      hasComparisonData ? comparisonMetricSeries[key] : undefined;
    const formatCount = (value: number) =>
      numberFormat(locale, Math.round(value));
    return [
      {
        key: "views",
        value: numberFormat(locale, overview.data.views),
        delta: toDeltaPercent(overview.data.views, reference.views),
        trend: metricSeries.views,
        comparisonTrend: comparisonTrend("views"),
        formatTrendValue: formatCount,
      },
      {
        key: "visitors",
        value: numberFormat(locale, overview.data.visitors),
        delta: toDeltaPercent(overview.data.visitors, reference.visitors),
        trend: metricSeries.visitors,
        comparisonTrend: comparisonTrend("visitors"),
        formatTrendValue: formatCount,
      },
      {
        key: "sessions",
        value: numberFormat(locale, overview.data.sessions),
        delta: toDeltaPercent(overview.data.sessions, reference.sessions),
        trend: metricSeries.sessions,
        comparisonTrend: comparisonTrend("sessions"),
        formatTrendValue: formatCount,
      },
      {
        key: "bounceRate",
        value: percentFormat(locale, overview.data.bounceRate),
        delta: toDeltaPercent(overview.data.bounceRate, reference.bounceRate),
        lowerIsBetter: true,
        trend: metricSeries.bounceRate,
        comparisonTrend: comparisonTrend("bounceRate"),
        formatTrendValue: (value) => percentFormat(locale, value),
      },
      {
        key: "pagesPerSession",
        value: pagesPerSessionFormatter.format(currentPagesPerSession),
        delta: toDeltaPercent(currentPagesPerSession, referencePagesPerSession),
        trend: metricSeries.pagesPerSession,
        comparisonTrend: comparisonTrend("pagesPerSession"),
        formatTrendValue: (value) => pagesPerSessionFormatter.format(value),
      },
      {
        key: "avgDuration",
        value: durationFormat(locale, overview.data.avgDurationMs),
        delta: toDeltaPercent(
          overview.data.avgDurationMs,
          reference.avgDurationMs,
        ),
        trend: metricSeries.avgDuration,
        comparisonTrend: comparisonTrend("avgDuration"),
        formatTrendValue: (value) =>
          durationFormat(locale, Math.max(0, Math.round(value))),
      },
    ];
  }, [
    comparisonMetricSeries,
    currentPagesPerSession,
    hasComparisonData,
    locale,
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
  ]);

  return (
    <OverviewMetricsView
      items={items}
      labels={labels}
      loading={loading}
      locale={locale}
      timeZone={window.timeZone}
      interval={window.interval}
      animationKey={metricChartAnimationKey}
      comparisonLabel={comparisonLabel}
    />
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
