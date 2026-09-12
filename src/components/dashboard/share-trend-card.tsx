import { type ComponentType, memo, type ReactNode, useMemo } from "react";
import { RiLineChartLine } from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  ShareTrendAreaChart,
  type ShareTrendAreaPoint,
  type ShareTrendAreaSeries,
} from "@/components/dashboard/charts/share-trend-area-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
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
const COMPARISON_CHART_COLORS = [
  "var(--color-compare-chart-1)",
  "var(--color-compare-chart-2)",
  "var(--color-compare-chart-3)",
  "var(--color-compare-chart-4)",
  "var(--color-compare-chart-5)",
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

type ShareTrendDataWindow = Pick<
  TimeWindow,
  "from" | "to" | "interval" | "timeZone"
>;

function buildShareTrendSeries(
  trendData: BrowserTrendData,
  otherLabel: string,
  palette: ReadonlyArray<string>,
  formatSeriesLabel?: (series: BrowserTrendSeries) => string,
  resolveSeriesIcon?: (
    series: BrowserTrendSeries,
  ) => ComponentType<{ className?: string }> | undefined,
): ShareTrendAreaSeries[] {
  return trendData.series.map((series, index) => ({
    key: series.key,
    label: seriesDisplayLabel(series, otherLabel, formatSeriesLabel),
    icon: series.isOther ? undefined : resolveSeriesIcon?.(series),
    color: series.isOther
      ? "var(--muted-foreground)"
      : (palette[index % palette.length] ?? "var(--muted-foreground)"),
    isOther: series.isOther,
  }));
}

interface ShareTrendSeriesAlignment {
  series: BrowserTrendSeries[];
  sourceKeys: string[][];
}

function findComparisonSeries(
  primarySeries: BrowserTrendSeries,
  comparisonSeries: ReadonlyArray<BrowserTrendSeries>,
  usedSeries: ReadonlySet<BrowserTrendSeries>,
): BrowserTrendSeries | undefined {
  if (primarySeries.isOther) {
    return comparisonSeries.find(
      (series) => series.isOther && !usedSeries.has(series),
    );
  }

  return (
    comparisonSeries.find(
      (series) =>
        !series.isOther &&
        !usedSeries.has(series) &&
        series.label === primarySeries.label,
    ) ??
    comparisonSeries.find(
      (series) =>
        !series.isOther &&
        !usedSeries.has(series) &&
        series.key === primarySeries.key,
    )
  );
}

function alignComparisonTrendData(
  primarySeries: ReadonlyArray<BrowserTrendSeries>,
  comparisonTrendData: BrowserTrendData,
): BrowserTrendData {
  const usedComparisonSeries = new Set<BrowserTrendSeries>();
  const alignedSeries: ShareTrendSeriesAlignment["series"] = [];
  const sourceKeys: ShareTrendSeriesAlignment["sourceKeys"] = [];

  for (const primary of primarySeries) {
    const comparison = findComparisonSeries(
      primary,
      comparisonTrendData.series,
      usedComparisonSeries,
    );
    if (comparison) usedComparisonSeries.add(comparison);

    alignedSeries.push({
      ...(comparison ?? primary),
      key: primary.key,
      label: primary.label,
      isOther: primary.isOther,
    });
    sourceKeys.push(comparison ? [comparison.key] : []);
  }

  const comparisonOnlySeries = comparisonTrendData.series.filter(
    (series) => !usedComparisonSeries.has(series),
  );
  const primaryOtherIndex = primarySeries.findIndex((series) => series.isOther);

  if (primaryOtherIndex >= 0) {
    const otherSourceKeys = sourceKeys[primaryOtherIndex] ?? [];
    otherSourceKeys.push(...comparisonOnlySeries.map((series) => series.key));
    sourceKeys[primaryOtherIndex] = otherSourceKeys;
  } else {
    const comparisonOnlyCategories = comparisonOnlySeries.filter(
      (series) => !series.isOther,
    );
    const comparisonOnlyOther = comparisonOnlySeries.find(
      (series) => series.isOther,
    );

    for (const series of comparisonOnlyCategories) {
      alignedSeries.push(series);
      sourceKeys.push([series.key]);
    }
    if (comparisonOnlyOther) {
      alignedSeries.push(comparisonOnlyOther);
      sourceKeys.push([comparisonOnlyOther.key]);
    }
  }

  return {
    ...comparisonTrendData,
    series: alignedSeries,
    data: comparisonTrendData.data.map((point) => ({
      ...point,
      visitorsBySeries: Object.fromEntries(
        alignedSeries.map((series, index) => [
          series.key,
          (sourceKeys[index] ?? []).reduce(
            (total, sourceKey) =>
              total +
              Math.max(0, Number(point.visitorsBySeries[sourceKey] ?? 0)),
            0,
          ),
        ]),
      ),
    })),
  };
}

function buildShareTrendAreaData(
  trendData: BrowserTrendData,
  dataWindow: ShareTrendDataWindow,
  hydrated: boolean,
): ShareTrendAreaPoint[] {
  return hydrated
    ? trendData.data.map((point) => ({
        timestampMs: point.timestampMs,
        totalVisitors: point.totalVisitors,
        values: point.visitorsBySeries,
      }))
    : buildEmptyShareTrendPoints(dataWindow);
}

function ShareTrendPeriodLabel({ label }: { label: string }) {
  return (
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
  );
}

export interface ShareTrendChartCardProps {
  locale: Locale;
  messages: AppMessages;
  title: string;
  trendData: BrowserTrendData;
  dataWindow: ShareTrendDataWindow;
  comparisonTrendData?: BrowserTrendData | null;
  comparisonDataWindow?: ShareTrendDataWindow | null;
  comparisonLabel?: string;
  currentPeriodLabel?: string;
  syncId?: string;
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
  comparisonTrendData,
  comparisonDataWindow,
  comparisonLabel,
  currentPeriodLabel = messages.dashboardHeader.compareCurrentPeriod,
  syncId,
  loading,
  hydrated,
  otherLabel = messages.browsers.otherLabel,
  headerBelow,
  formatSeriesLabel,
  resolveSeriesIcon,
}: ShareTrendChartCardProps) {
  const chartSeries = useMemo(
    () =>
      buildShareTrendSeries(
        trendData,
        otherLabel,
        CHART_COLORS,
        formatSeriesLabel,
        resolveSeriesIcon,
      ),
    [formatSeriesLabel, otherLabel, resolveSeriesIcon, trendData.series],
  );
  const alignedComparisonTrendData = useMemo(
    () =>
      comparisonTrendData
        ? alignComparisonTrendData(trendData.series, comparisonTrendData)
        : null,
    [comparisonTrendData, trendData.series],
  );
  const comparisonChartSeries = useMemo(
    () =>
      alignedComparisonTrendData
        ? buildShareTrendSeries(
            alignedComparisonTrendData,
            otherLabel,
            COMPARISON_CHART_COLORS,
            formatSeriesLabel,
            resolveSeriesIcon,
          )
        : [],
    [
      alignedComparisonTrendData,
      formatSeriesLabel,
      otherLabel,
      resolveSeriesIcon,
    ],
  );
  const initialChartLoading = loading && !hydrated;
  const chartData = useMemo(
    () => buildShareTrendAreaData(trendData, dataWindow, hydrated),
    [
      dataWindow.from,
      dataWindow.interval,
      dataWindow.timeZone,
      dataWindow.to,
      hydrated,
      trendData.data,
    ],
  );
  const comparisonChartData = useMemo(
    () =>
      alignedComparisonTrendData && comparisonDataWindow
        ? buildShareTrendAreaData(
            alignedComparisonTrendData,
            comparisonDataWindow,
            true,
          )
        : [],
    [alignedComparisonTrendData, comparisonDataWindow],
  );
  const hasContent = chartSeries.length > 0 && chartData.length > 0;
  const shouldRenderChart = hasContent || initialChartLoading;
  const hasComparison = Boolean(comparisonTrendData && comparisonDataWindow);
  const hasComparisonContent =
    comparisonChartSeries.length > 0 && comparisonChartData.length > 0;
  const comparisonTransitionKey = hasComparison
    ? hasComparisonContent
      ? "content"
      : "empty"
    : "hidden";

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
          hasContent={shouldRenderChart || hasComparison}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[360px]"
          initial={false}
        >
          <div className="grid gap-6">
            <AutoResizer className="min-w-0" duration={0.2}>
              <AutoTransition
                initial={false}
                transitionKey={shouldRenderChart ? "content" : "empty"}
                duration={0.2}
                type="crossFade"
              >
                {shouldRenderChart ? (
                  <div key="current" className="grid gap-2">
                    {hasComparison ? (
                      <ShareTrendPeriodLabel label={currentPeriodLabel} />
                    ) : null}
                    <ShareTrendAreaChart
                      data={chartData}
                      series={chartSeries}
                      locale={locale}
                      timeZone={dataWindow.timeZone}
                      interval={dataWindow.interval}
                      axisDateFormat={
                        dataWindow.interval === "minute" ||
                        dataWindow.interval === "hour"
                          ? "time"
                          : "regular"
                      }
                      syncId={hasComparison ? syncId : undefined}
                      loading={loading}
                      showLegend
                    />
                  </div>
                ) : (
                  <div
                    key="empty"
                    className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground"
                  >
                    {messages.common.noData}
                  </div>
                )}
              </AutoTransition>
            </AutoResizer>

            {hasComparison ? (
              <AutoResizer className="min-w-0" duration={0.2}>
                <AutoTransition
                  initial={false}
                  transitionKey={comparisonTransitionKey}
                  duration={0.2}
                  type="crossFade"
                >
                  <div
                    key={`comparison-${comparisonTransitionKey}`}
                    className="grid gap-2"
                  >
                    <ShareTrendPeriodLabel
                      label={
                        comparisonLabel ??
                        messages.dashboardHeader.compareButton
                      }
                    />
                    {hasComparisonContent && comparisonDataWindow ? (
                      <ShareTrendAreaChart
                        data={comparisonChartData}
                        series={comparisonChartSeries}
                        locale={locale}
                        timeZone={comparisonDataWindow.timeZone}
                        interval={comparisonDataWindow.interval}
                        axisDateFormat={
                          comparisonDataWindow.interval === "minute" ||
                          comparisonDataWindow.interval === "hour"
                            ? "time"
                            : "regular"
                        }
                        syncId={syncId}
                        loading={loading}
                        showLegend
                      />
                    ) : (
                      <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
                        {messages.common.noData}
                      </div>
                    )}
                  </div>
                </AutoTransition>
              </AutoResizer>
            ) : null}
          </div>
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
  const comparisonQuery = useDashboardComparisonQuery(window, filters);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const currentDataWindow = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.timeZone, window.to],
  );
  const comparisonDataWindow = useMemo(
    () =>
      comparisonQuery
        ? {
            from: comparisonQuery.window.from,
            to: comparisonQuery.window.to,
            interval: comparisonQuery.window.interval,
            timeZone: comparisonQuery.window.timeZone,
          }
        : null,
    [comparisonQuery],
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
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? "none",
      comparisonQuery?.window.to ?? "none",
      comparisonQuery?.window.interval ?? "none",
      comparisonQuery?.window.timeZone ?? "none",
      comparisonFiltersKey,
      limit,
    ],
    queryFn: async ({ signal }) => {
      const fetchShareTrend = (
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchTrend(siteId, requestedWindow, requestedFilters, {
          limit,
          signal,
        }).catch((error) =>
          fallbackUnlessAborted(error, () =>
            emptyTrendData(requestedWindow.interval),
          ),
        );
      const [trendData, comparisonTrendData] = await Promise.all([
        fetchShareTrend(window, filters),
        comparisonQuery
          ? fetchShareTrend(comparisonQuery.window, comparisonQuery.filters)
          : Promise.resolve(null),
      ]);
      return {
        trendData,
        comparisonTrendData,
        dataWindow: currentDataWindow,
        comparisonDataWindow,
      };
    },
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
  const comparisonTrendData = comparisonQuery
    ? trendQueryData?.comparisonTrendData
    : undefined;
  const resolvedComparisonDataWindow = comparisonQuery
    ? (trendQueryData?.comparisonDataWindow ?? comparisonDataWindow)
    : null;
  const hydrated = Boolean(trendQueryData);
  const syncId = useMemo(
    () =>
      ["share-trend", siteId, ...queryKey.map((value) => String(value))].join(
        ":",
      ),
    [queryKey, siteId],
  );

  return (
    <ShareTrendChartCard
      locale={locale}
      messages={messages}
      title={title}
      trendData={trendData}
      dataWindow={dataWindow}
      comparisonTrendData={comparisonTrendData}
      comparisonDataWindow={resolvedComparisonDataWindow}
      comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
      syncId={syncId}
      loading={loading}
      hydrated={hydrated}
      otherLabel={otherLabel}
      headerBelow={headerBelow}
      formatSeriesLabel={formatSeriesLabel}
      resolveSeriesIcon={resolveSeriesIcon}
    />
  );
}, areShareTrendCardPropsEqual);
