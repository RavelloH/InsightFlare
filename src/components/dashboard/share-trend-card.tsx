import { type ComponentType, memo, type ReactNode, useMemo } from "react";
import { RiLineChartLine } from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  ShareTrendAreaChart,
  type ShareTrendAreaPoint,
  type ShareTrendAreaSeries,
} from "@/components/dashboard/charts/share-trend-area-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type {
  DashboardInterval,
  TimeWindow,
} from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;

export type ShareTrendFetcher = (
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
) => Promise<BrowserTrendData>;

interface ShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  queryKey: readonly unknown[];
  title: string;
  fetchTrend: ShareTrendFetcher;
  limit?: number;
  otherLabel?: string;
  headerBelow?: ReactNode;
  formatSeriesLabel?: (series: BrowserTrendSeries) => string;
  resolveSeriesIcon?: (
    series: BrowserTrendSeries,
  ) => ComponentType<{ className?: string }> | undefined;
}

function emptyTrendData(interval: DashboardInterval): BrowserTrendData {
  return {
    ok: true,
    interval,
    series: [],
    data: [],
  };
}

const MAX_SHARE_TREND_PLACEHOLDER_POINTS = 120;

function shareTrendStepMs(interval: DashboardInterval): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function buildEmptyShareTrendPoints(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): ShareTrendAreaPoint[] {
  const timestamps: number[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );

  for (let index = 0; index < 2000 && current <= end; index += 1) {
    timestamps.push(current);
    let next = addZonedInterval(current, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + shareTrendStepMs(window.interval);
    }
    current = next;
  }

  const stride = Math.max(
    1,
    Math.ceil(timestamps.length / MAX_SHARE_TREND_PLACEHOLDER_POINTS),
  );
  const points = timestamps
    .filter((_, index) => index % stride === 0)
    .map((timestampMs) => ({
      timestampMs,
      totalVisitors: 0,
      values: {},
    }));
  const lastTimestampMs = timestamps[timestamps.length - 1] ?? 0;

  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      totalVisitors: 0,
      values: {},
    });
  }

  return points;
}

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

function seriesDisplayLabel(
  series: BrowserTrendSeries,
  otherLabel: string,
  formatSeriesLabel?: (series: BrowserTrendSeries) => string,
): string {
  if (series.isOther) return otherLabel;
  return formatSeriesLabel ? formatSeriesLabel(series) : series.label;
}

export interface ShareTrendChartCardProps {
  locale: Locale;
  messages: AppMessages;
  title: string;
  trendData: BrowserTrendData;
  dataWindow: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">;
  loading: boolean;
  hydrated: boolean;
  otherLabel?: string;
  headerBelow?: ReactNode;
  formatSeriesLabel?: (series: BrowserTrendSeries) => string;
  resolveSeriesIcon?: (
    series: BrowserTrendSeries,
  ) => ComponentType<{ className?: string }> | undefined;
}

export const ShareTrendChartCard = memo(function ShareTrendChartCard({
  locale,
  messages,
  title,
  trendData,
  dataWindow,
  loading,
  hydrated,
  otherLabel = messages.browsers.otherLabel,
  headerBelow,
  formatSeriesLabel,
  resolveSeriesIcon,
}: ShareTrendChartCardProps) {
  const chartSeries = useMemo(
    (): ShareTrendAreaSeries[] =>
      trendData.series.map((series, index) => ({
        key: series.key,
        label: seriesDisplayLabel(series, otherLabel, formatSeriesLabel),
        icon: series.isOther ? undefined : resolveSeriesIcon?.(series),
        color: series.isOther
          ? "var(--muted-foreground)"
          : CHART_COLORS[index % CHART_COLORS.length],
        isOther: series.isOther,
      })),
    [formatSeriesLabel, otherLabel, resolveSeriesIcon, trendData.series],
  );
  const initialChartLoading = loading && !hydrated;
  const chartData = useMemo<ShareTrendAreaPoint[]>(
    () =>
      hydrated
        ? trendData.data.map((point) => ({
            timestampMs: point.timestampMs,
            totalVisitors: point.totalVisitors,
            values: point.visitorsBySeries,
          }))
        : buildEmptyShareTrendPoints(dataWindow),
    [
      dataWindow.from,
      dataWindow.interval,
      dataWindow.timeZone,
      dataWindow.to,
      hydrated,
      trendData.data,
    ],
  );
  const hasContent = chartSeries.length > 0 && chartData.length > 0;
  const shouldRenderChart = hasContent || initialChartLoading;

  return (
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiLineChartLine className="size-4" />
          {title}
        </CardTitle>
        {headerBelow ? <div>{headerBelow}</div> : null}
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={false}
          hasContent={shouldRenderChart}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[360px]"
          initial={false}
        >
          <ShareTrendAreaChart
            data={chartData}
            series={chartSeries}
            locale={locale}
            timeZone={dataWindow.timeZone}
            interval={dataWindow.interval}
            axisDateFormat={
              dataWindow.interval === "minute" || dataWindow.interval === "hour"
                ? "time"
                : "regular"
            }
            loading={loading}
            showLegend
          />
        </ContentSwitch>
      </CardContent>
    </Card>
  );
});

function areShareTrendCardPropsEqual(
  previous: ShareTrendCardProps,
  next: ShareTrendCardProps,
): boolean {
  return (
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.siteId === next.siteId &&
    previous.window === next.window &&
    previous.filters === next.filters &&
    previous.title === next.title &&
    previous.fetchTrend === next.fetchTrend &&
    previous.limit === next.limit &&
    previous.otherLabel === next.otherLabel &&
    previous.headerBelow === next.headerBelow &&
    previous.formatSeriesLabel === next.formatSeriesLabel &&
    previous.resolveSeriesIcon === next.resolveSeriesIcon &&
    previous.queryKey.length === next.queryKey.length &&
    previous.queryKey.every((value, index) => value === next.queryKey[index])
  );
}

export const ShareTrendCard = memo(function ShareTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  queryKey,
  title,
  fetchTrend,
  limit = 5,
  otherLabel = messages.browsers.otherLabel,
  headerBelow,
  formatSeriesLabel,
  resolveSeriesIcon,
}: ShareTrendCardProps) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
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
  } = useQuery({
    queryKey: [
      "dashboard",
      "share-trend",
      ...queryKey,
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      limit,
    ],
    queryFn: async ({ signal }) => ({
      trendData: await fetchTrend(siteId, window, filters, {
        limit,
        signal,
      }).catch((error) =>
        fallbackUnlessAborted(error, () => emptyTrendData(window.interval)),
      ),
      dataWindow: currentDataWindow,
    }),
    enabled: !import.meta.env.SSR,
    placeholderData: keepPreviousData,
  });
  const loading = isPending || isFetching;
  const fallbackTrendData = useMemo(
    () => emptyTrendData(window.interval),
    [window.interval],
  );
  const trendData = trendQueryData?.trendData ?? fallbackTrendData;
  const dataWindow = trendQueryData?.dataWindow ?? currentDataWindow;
  const hydrated = Boolean(trendQueryData);

  return (
    <ShareTrendChartCard
      locale={locale}
      messages={messages}
      title={title}
      trendData={trendData}
      dataWindow={dataWindow}
      loading={loading}
      hydrated={hydrated}
      otherLabel={otherLabel}
      headerBelow={headerBelow}
      formatSeriesLabel={formatSeriesLabel}
      resolveSeriesIcon={resolveSeriesIcon}
    />
  );
}, areShareTrendCardPropsEqual);
