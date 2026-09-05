import {
  type ComponentProps,
  type ComponentType,
  memo,
  useCallback,
  useMemo,
  useState,
} from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
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
  useAnimationOnChartSwitch,
  useChartVisibility,
} from "@/hooks/use-chart-animation";
import {
  type ChartAxisDateFormat,
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface ShareTrendAreaSeries {
  key: string;
  label: string;
  color: string;
  icon?: ComponentType<{ className?: string }>;
  isOther?: boolean;
}

export interface ShareTrendAreaPoint {
  timestampMs: number;
  totalVisitors: number;
  values: Readonly<Record<string, number>>;
}

export interface ShareTrendAreaChartProps {
  data: ReadonlyArray<ShareTrendAreaPoint>;
  series: ReadonlyArray<ShareTrendAreaSeries>;
  locale: Locale;
  timeZone: string;
  interval: DashboardInterval;
  axisDateFormat?: ChartAxisDateFormat;
  showLegend?: boolean;
  loading?: boolean;
  className?: string;
}

const SHARE_TREND_AREA_ANIMATION_DURATION = 280;
const LOADING_SERIES_KEY = "__share-trend-loading__";
const SHARE_TREND_LEGEND_HEIGHT = 48;
const SHARE_TREND_LEGEND_CLASS =
  "pt-6 flex-wrap justify-center gap-x-4 gap-y-2 [&>div>div]:h-2.5 [&>div>div]:w-2.5 [&>div>div]:shrink-0 [&>div>div]:rounded-none";

const LOADING_SERIES: ShareTrendAreaSeries = {
  key: LOADING_SERIES_KEY,
  label: "",
  color: "var(--muted-foreground)",
};

const SHARE_TREND_LEGEND_SKELETON_COUNT = 6;

function ShareTrendLegendSkeleton() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex flex-wrap justify-center gap-3",
        SHARE_TREND_LEGEND_CLASS,
      )}
    >
      {Array.from({ length: SHARE_TREND_LEGEND_SKELETON_COUNT }, (_, index) => (
        <Skeleton
          key={`share-trend-legend-skeleton-${index}`}
          className="h-4 w-20"
        />
      ))}
    </div>
  );
}

function ShareTrendLegendContent({
  showSkeleton,
  payload,
}: ComponentProps<typeof ChartLegendContent> & { showSkeleton: boolean }) {
  const transitionKey = showSkeleton
    ? "loading"
    : payload?.length
      ? "content"
      : "empty";

  return (
    <AutoTransition
      className="h-full w-full"
      initial={false}
      transitionKey={transitionKey}
      duration={0.2}
      type="crossFade"
    >
      {showSkeleton ? (
        <ShareTrendLegendSkeleton key="loading" />
      ) : payload?.length ? (
        <ChartLegendContent
          key="content"
          className={SHARE_TREND_LEGEND_CLASS}
          payload={payload}
        />
      ) : null}
    </AutoTransition>
  );
}

export const ShareTrendAreaChart = memo(function ShareTrendAreaChart({
  data,
  series,
  locale,
  timeZone,
  interval,
  axisDateFormat = "regular",
  showLegend = true,
  loading = false,
  className,
}: ShareTrendAreaChartProps) {
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility("80px 0px");
  const [hasChartSize, setHasChartSize] = useState(false);
  const handleChartResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setHasChartSize(true);
  }, []);
  const renderSeries = useMemo(
    () => (series.length > 0 ? series : loading ? [LOADING_SERIES] : []),
    [loading, series],
  );
  const seriesByKey = useMemo(
    () => new Map(series.map((item) => [item.key, item] as const)),
    [series],
  );
  const chartData = useMemo(() => {
    const rows = data.map((point) => {
      const row: Record<string, number> = {
        timestampMs: Number.isFinite(point.timestampMs) ? point.timestampMs : 0,
        totalVisitors: Number.isFinite(point.totalVisitors)
          ? Math.max(0, point.totalVisitors)
          : 0,
      };

      for (const item of renderSeries) {
        const value = Number(point.values[item.key] ?? 0);
        row[item.key] = Number.isFinite(value) ? Math.max(0, value) : 0;
      }

      return row;
    });

    if (rows.length >= 2) return rows;

    if (rows.length === 1) {
      const first = rows[0] ?? {
        timestampMs: 0,
        totalVisitors: 0,
      };
      return [
        first,
        {
          ...first,
          timestampMs: first.timestampMs + 1,
        },
      ];
    }

    return [
      {
        timestampMs: 0,
        totalVisitors: 0,
        ...Object.fromEntries(renderSeries.map((item) => [item.key, 0])),
      },
      {
        timestampMs: 1,
        totalVisitors: 0,
        ...Object.fromEntries(renderSeries.map((item) => [item.key, 0])),
      },
    ];
  }, [data, renderSeries]);
  const chartConfig = useMemo(
    () =>
      renderSeries.reduce((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.color,
          icon: item.icon,
        };
        return config;
      }, {} as ChartConfig),
    [renderSeries],
  );
  const axisFormatter = useMemo(
    () =>
      createChartAxisDateFormatter(locale, interval, timeZone, axisDateFormat),
    [axisDateFormat, interval, locale, timeZone],
  );
  const tooltipFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [interval, locale, timeZone],
  );
  const sharePercentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [locale],
  );
  const axisPercentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        style: "percent",
        maximumFractionDigits: 0,
      }),
    [locale],
  );
  const shareChartSwitchKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${interval}:${renderSeries.map((item) => item.key).join(",")}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [chartData, interval, renderSeries]);
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: shareChartSwitchKey,
    hasData: series.length > 0 && data.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="relative w-full">
      <ChartContainer
        config={chartConfig}
        className={cn(
          "h-[360px] w-full aspect-auto transition-opacity duration-200",
          hasChartSize ? "opacity-100" : "opacity-0",
          loading
            ? "[&_.recharts-area-area]:brightness-50"
            : "[&_.recharts-area-area]:brightness-100",
          className,
        )}
        onChartResize={handleChartResize}
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
              axisFormatter.format(new Date(Number(value ?? 0)))
            }
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={12}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(value) =>
              axisPercentFormatter.format(Number(value ?? 0))
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
                  const row = payload as unknown as Record<string, number>;
                  const seriesKey = String(name ?? "");
                  const numeric = Math.max(
                    0,
                    Number(row[seriesKey] ?? value ?? 0),
                  );
                  const totalVisitors = Math.max(
                    0,
                    Number(row.totalVisitors ?? 0),
                  );
                  const share = totalVisitors > 0 ? numeric / totalVisitors : 0;
                  const currentSeries = seriesByKey.get(seriesKey);
                  const SeriesIcon = currentSeries?.icon;

                  return (
                    <div className="flex w-full items-center gap-3">
                      <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        {SeriesIcon ? (
                          <SeriesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-none"
                            style={{
                              backgroundColor: currentSeries?.color,
                            }}
                          />
                        )}
                        <span className="truncate text-muted-foreground">
                          {currentSeries?.label ?? seriesKey}
                        </span>
                      </span>
                      <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                        {numberFormat(locale, numeric)} ·{" "}
                        {share < 0.1 ? "\u00a0" : ""}
                        {sharePercentFormatter.format(share)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {showLegend ? (
            <ChartLegend
              height={SHARE_TREND_LEGEND_HEIGHT}
              content={
                <ShareTrendLegendContent
                  showSkeleton={loading && series.length === 0}
                />
              }
            />
          ) : null}
          {renderSeries.map((item) => (
            <Area
              key={item.key}
              dataKey={item.key}
              type="monotone"
              fill={item.color}
              fillOpacity={
                item.key === LOADING_SERIES_KEY ? 0 : item.isOther ? 0.18 : 0.42
              }
              stroke={item.color}
              strokeOpacity={item.key === LOADING_SERIES_KEY ? 0.3 : 1}
              strokeWidth={1.6}
              stackId="share"
              isAnimationActive={isAnimationActive}
              animationDuration={
                isAnimationActive ? SHARE_TREND_AREA_ANIMATION_DURATION : 0
              }
            />
          ))}
        </AreaChart>
      </ChartContainer>
      {showLegend && loading && series.length === 0 && !hasChartSize ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-12 items-start justify-center"
        >
          <ShareTrendLegendSkeleton />
        </div>
      ) : null}
      <AutoTransition
        initial={false}
        aria-hidden={!loading && hasChartSize}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center text-muted-foreground",
          showLegend ? "bottom-12" : "bottom-0",
        )}
        transitionKey={loading || !hasChartSize ? "loading" : "ready"}
        duration={0.2}
        presenceMode="sync"
      >
        {loading || !hasChartSize ? (
          <Spinner key="share-trend-loading-indicator" className="size-5" />
        ) : null}
      </AutoTransition>
    </div>
  );
});
