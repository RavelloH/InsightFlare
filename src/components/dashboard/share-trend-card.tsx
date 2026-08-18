import { type ComponentType, type ReactNode, useMemo } from "react";
import { RiLineChartLine } from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ContentSwitch } from "@/components/dashboard/content-switch";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type {
  DashboardInterval,
  TimeWindow,
} from "@/lib/dashboard/query-state";
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

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

function tickDateFormat(
  localeCode: string,
  interval: DashboardInterval,
  timeZone: string,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "short",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    month: "short",
    day: "numeric",
  });
}

function tooltipDateFormat(
  localeCode: string,
  interval: DashboardInterval,
  timeZone: string,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "long",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function seriesDisplayLabel(
  series: BrowserTrendSeries,
  otherLabel: string,
  formatSeriesLabel?: (series: BrowserTrendSeries) => string,
): string {
  if (series.isOther) return otherLabel;
  return formatSeriesLabel ? formatSeriesLabel(series) : series.label;
}

function ShareTrendCardSkeleton() {
  return (
    <div className="space-y-6 min-h-[360px]">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="flex flex-wrap justify-start gap-2 sm:justify-end">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton
              key={`share-trend-legend-skeleton-${index}`}
              className="h-5 w-20"
            />
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <Skeleton className="h-[260px] w-full" />
        <div className="flex flex-wrap justify-center gap-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton
              key={`share-trend-label-skeleton-${index}`}
              className="h-4 w-20"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ShareTrendCard({
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
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
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
    enabled: typeof window !== "undefined",
    placeholderData: keepPreviousData,
  });
  const loading = isPending || isFetching;
  const trendData =
    trendQueryData?.trendData ?? emptyTrendData(window.interval);
  const dataWindow = trendQueryData?.dataWindow ?? currentDataWindow;
  const hydrated = Boolean(trendQueryData);

  const localeCode = intlLocale(locale);
  const axisTickFormatter = useMemo(
    () => tickDateFormat(localeCode, dataWindow.interval, dataWindow.timeZone),
    [dataWindow.interval, dataWindow.timeZone, localeCode],
  );
  const tooltipFormatter = useMemo(
    () =>
      tooltipDateFormat(localeCode, dataWindow.interval, dataWindow.timeZone),
    [dataWindow.interval, dataWindow.timeZone, localeCode],
  );
  const chartSeries = useMemo(
    () =>
      trendData.series.map((series, index) => ({
        ...series,
        displayLabel: seriesDisplayLabel(series, otherLabel, formatSeriesLabel),
        Icon: series.isOther ? undefined : resolveSeriesIcon?.(series),
        color: series.isOther
          ? "var(--muted-foreground)"
          : CHART_COLORS[index % CHART_COLORS.length],
      })),
    [formatSeriesLabel, otherLabel, resolveSeriesIcon, trendData.series],
  );
  const chartConfig = useMemo(
    () =>
      chartSeries.reduce((config, series) => {
        config[series.key] = {
          label: series.displayLabel,
          color: series.color,
          icon: series.Icon,
        };
        return config;
      }, {} as ChartConfig),
    [chartSeries],
  );
  const chartData = useMemo(
    () =>
      trendData.data.map((point) => {
        const row: Record<string, number> = {
          timestampMs: point.timestampMs,
          totalVisitors: point.totalVisitors,
        };
        for (const series of chartSeries) {
          row[series.key] = Number(point.visitorsBySeries[series.key] ?? 0);
        }
        return row;
      }),
    [chartSeries, trendData.data],
  );
  const showOverlayLoading = loading && hydrated;
  const hasContent = chartSeries.length > 0 && chartData.length > 0;

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
          loading={loading && !hydrated}
          hasContent={hasContent}
          loadingLabel={messages.common.loading}
          loadingContent={<ShareTrendCardSkeleton />}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[360px]"
        >
          <div className="relative">
            <ChartContainer
              className="h-[360px] w-full aspect-auto"
              config={chartConfig}
            >
              <AreaChart
                accessibilityLayer
                data={chartData}
                margin={{ left: 12, right: 12, top: 12 }}
                stackOffset="expand"
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="timestampMs"
                  tickFormatter={(value) =>
                    axisTickFormatter.format(new Date(Number(value ?? 0)))
                  }
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={12}
                />
                <YAxis
                  tickFormatter={(value) =>
                    percentFormat(locale, Number(value ?? 0))
                  }
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      className="min-w-[16rem]"
                      indicator="line"
                      labelFormatter={(value, payload) => {
                        const timestamp = Number(
                          payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                        );
                        return tooltipFormatter.format(new Date(timestamp));
                      }}
                      formatter={(value, name, _item, _index, payload) => {
                        const row = payload as unknown as Record<
                          string,
                          number
                        >;
                        const seriesKey = String(name ?? "");
                        const numeric = Math.max(
                          0,
                          Number(row[seriesKey] ?? value ?? 0),
                        );
                        const totalVisitors = Math.max(
                          0,
                          Number(row.totalVisitors ?? 0),
                        );
                        const share =
                          totalVisitors > 0 ? numeric / totalVisitors : 0;
                        const currentSeries = chartSeries.find(
                          (item) => item.key === seriesKey,
                        );
                        const SeriesIcon = currentSeries?.Icon;
                        return (
                          <div className="flex w-full items-center gap-3">
                            <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                              {SeriesIcon ? (
                                <SeriesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                  style={{
                                    backgroundColor: currentSeries?.color,
                                  }}
                                />
                              )}
                              <span
                                className="truncate text-muted-foreground"
                                title={currentSeries?.displayLabel ?? seriesKey}
                              >
                                {currentSeries?.displayLabel ?? seriesKey}
                              </span>
                            </span>
                            <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                              {numberFormat(locale, numeric)} ·{" "}
                              {percentFormat(locale, share)}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
                <ChartLegend
                  content={
                    <ChartLegendContent className="pt-6 flex-wrap justify-center gap-x-4 gap-y-2" />
                  }
                />
                {chartSeries.map((series) => (
                  <Area
                    key={series.key}
                    dataKey={series.key}
                    type="monotone"
                    fill={`var(--color-${series.key})`}
                    fillOpacity={series.isOther ? 0.18 : 0.42}
                    stroke={`var(--color-${series.key})`}
                    strokeWidth={1.6}
                    stackId="share"
                    isAnimationActive
                  />
                ))}
              </AreaChart>
            </ChartContainer>

            <AutoTransition
              type="fade"
              duration={0.22}
              className="pointer-events-none absolute top-2 right-2"
            >
              {showOverlayLoading ? (
                <span
                  key="share-trend-overlay-loading"
                  className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
                >
                  <Spinner className="size-3.5" />
                  {messages.common.loading}
                </span>
              ) : (
                <div
                  key="share-trend-overlay-idle"
                  className="h-0 w-0 overflow-hidden"
                />
              )}
            </AutoTransition>
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
}
