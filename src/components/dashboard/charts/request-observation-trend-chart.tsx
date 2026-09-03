import { memo, useMemo } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Customized,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import type { CategoricalChartState } from "recharts/types/chart/types";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  durationFormat,
  intlLocale,
  percentFormat,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface RequestObservationTrendPoint {
  timestampMs: number;
  count: number;
  baselineCount: number;
  normalCount: number;
  suspectedBotCount: number;
  botCount: number;
  customBlockedCount: number;
  includedCount: number;
  blockedCount: number;
  totalCount: number;
  botRatio: number;
  blockedRatio: number;
  normalRatio: number;
  pageviews: number;
  customEvents: number;
  pageviewCount: number;
  leaveCount: number;
  visibilityCount: number;
  customEventCount: number;
  identifyCount: number;
  weightedRequestCount: number;
  latencyWeightedSumMs: number;
  latencySampleWeight: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p75LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

export interface RequestObservationTrendLabels {
  normalRequests: string;
  suspectedBotRequests: string;
  botRequests: string;
  customBlockedRequests: string;
  includedRequests: string;
  blockedRequests: string;
  totalRequests: string;
  pageviews: string;
  customEvents: string;
  pageview: string;
  leave: string;
  visibility: string;
  customEvent: string;
  identify: string;
  botRatio: string;
  blockedRatio: string;
  normalRatio: string;
  avgLatency: string;
  p50Latency: string;
  p75Latency: string;
  p95Latency: string;
  p99Latency: string;
  normalTrafficShare: string;
  suspectedBotTraffic: string;
  botTraffic: string;
  customBlockedTraffic: string;
}

export type RequestObservationTrendVariant =
  | "overview"
  | "traffic-composition"
  | "latency"
  | "blocked"
  | "included";

export interface RequestObservationTrendChartProps {
  data: ReadonlyArray<RequestObservationTrendPoint>;
  labels: RequestObservationTrendLabels;
  locale: Locale;
  spanMs: number;
  variant: RequestObservationTrendVariant;
  className?: string;
  latencyFormatter?: (valueMs: number) => string;
}

const PERFORMANCE_WARNING_COLOR = "oklch(0.75 0.16 80)";
const NORMAL_TRAFFIC_SHARE_COLOR = "var(--color-chart-4)";
const SUSPECTED_BOT_TRAFFIC_COLOR = PERFORMANCE_WARNING_COLOR;
const BOT_TRAFFIC_COLOR = "var(--color-destructive)";
const CUSTOM_BLOCKED_TRAFFIC_COLOR = "var(--muted-foreground)";
const BUSINESS_CUSTOM_EVENT_COLOR = PERFORMANCE_WARNING_COLOR;
const BUSINESS_IDENTIFY_COLOR = "oklch(0.7 0.14 250)";

type RequestObservationHoverHighlightProps = Pick<
  CategoricalChartState,
  | "activeCoordinate"
  | "activeTooltipIndex"
  | "isTooltipActive"
  | "offset"
  | "tooltipAxisBandSize"
>;

function RequestObservationHoverHighlight({
  activeCoordinate,
  activeTooltipIndex,
  isTooltipActive,
  offset,
  tooltipAxisBandSize,
}: RequestObservationHoverHighlightProps) {
  const bandSize = tooltipAxisBandSize ?? 0;
  if (
    !isTooltipActive ||
    activeTooltipIndex === undefined ||
    activeTooltipIndex < 0 ||
    !activeCoordinate ||
    !offset ||
    !Number.isFinite(bandSize) ||
    bandSize <= 0 ||
    (offset.height ?? 0) <= 0
  ) {
    return null;
  }

  return (
    <rect
      className="recharts-rectangle recharts-tooltip-cursor"
      x={activeCoordinate.x - bandSize / 2}
      y={(offset.top ?? 0) + 0.5}
      width={bandSize}
      height={(offset.height ?? 0) - 1}
      fill="var(--muted)"
      stroke="none"
      pointerEvents="none"
    />
  );
}

function trendTickDateFormat(
  locale: Locale,
  spanMs: number,
): Intl.DateTimeFormat {
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: "numeric",
    day: "numeric",
  });
}

function trendTooltipDateFormat(
  locale: Locale,
  spanMs: number,
): Intl.DateTimeFormat {
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function TrendTooltipValue({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-36 items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-none"
          style={{ backgroundColor: color }}
        />
        <span className="text-muted-foreground">{label}</span>
      </span>
      <span className="font-mono text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function createTrendTooltipFormatter({
  labels,
  latencyFormatter,
  locale,
}: {
  labels: RequestObservationTrendLabels;
  latencyFormatter: (valueMs: number) => string;
  locale: Locale;
}) {
  return function formatTrendTooltipValue(
    value: unknown,
    name: unknown,
    _item: unknown,
    _index: number,
    payload: unknown,
  ) {
    const key = String(name || "");
    const row = (payload ?? null) as Record<string, unknown> | null;
    const isRatio = key.endsWith("Ratio");
    // Latency fields are explicitly suffixed with Ms by the API. Delegate
    // formatting to the caller so the tooltip never assumes seconds.
    const isLatency = key.toLowerCase().includes("latency");
    const numeric = Number(value);
    const displayValue = Number(row?.[key] ?? numeric ?? 0);
    const formatted = isLatency
      ? latencyFormatter(Number.isFinite(displayValue) ? displayValue : 0)
      : isRatio
        ? percentFormat(
            locale,
            Number.isFinite(displayValue) ? displayValue : 0,
          )
        : new Intl.NumberFormat(intlLocale(locale)).format(
            Math.max(
              0,
              Math.round(Number.isFinite(displayValue) ? displayValue : 0),
            ),
          );
    const labelByDataKey: Record<string, string> = {
      normalCount: labels.normalTrafficShare,
      suspectedBotCount: labels.suspectedBotTraffic,
      botCount: labels.botTraffic,
      customBlockedCount: labels.customBlockedTraffic,
      includedCount: labels.includedRequests,
      blockedCount: labels.blockedRequests,
      totalCount: labels.totalRequests,
      pageviews: labels.pageviews,
      customEvents: labels.customEvents,
      pageviewCount: labels.pageview,
      leaveCount: labels.leave,
      visibilityCount: labels.visibility,
      customEventCount: labels.customEvent,
      identifyCount: labels.identify,
      botRatio: labels.botRatio,
      blockedRatio: labels.blockedRatio,
      normalRatio: labels.normalRatio,
      avgLatencyMs: labels.avgLatency,
      p50LatencyMs: labels.p50Latency,
      p75LatencyMs: labels.p75Latency,
      p95LatencyMs: labels.p95Latency,
      p99LatencyMs: labels.p99Latency,
    };
    const label =
      labelByDataKey[key] ??
      labels[key as keyof RequestObservationTrendLabels] ??
      (isRatio ? labels.blockedRatio : labels.totalRequests);
    const indicatorColor =
      key === "normalCount"
        ? "var(--color-normalCount)"
        : key === "suspectedBotCount"
          ? "var(--color-suspectedBotCount)"
          : key === "botCount"
            ? "var(--color-botCount)"
            : key === "customBlockedCount"
              ? "var(--color-customBlockedCount)"
              : key === "includedCount"
                ? "var(--color-includedCount)"
                : key === "blockedCount"
                  ? "var(--color-blockedCount)"
                  : key === "totalCount"
                    ? "var(--color-totalCount)"
                    : key === "pageviews"
                      ? "var(--color-pageviews)"
                      : key === "customEvents"
                        ? "var(--color-customEvents)"
                        : key === "pageviewCount"
                          ? "var(--color-pageviewCount)"
                          : key === "leaveCount"
                            ? "var(--color-leaveCount)"
                            : key === "visibilityCount"
                              ? "var(--color-visibilityCount)"
                              : key === "customEventCount"
                                ? "var(--color-customEventCount)"
                                : key === "identifyCount"
                                  ? "var(--color-identifyCount)"
                                  : key === "p50LatencyMs"
                                    ? "var(--color-p50LatencyMs)"
                                    : key === "p75LatencyMs"
                                      ? "var(--color-p75LatencyMs)"
                                      : key === "p95LatencyMs"
                                        ? "var(--color-p95LatencyMs)"
                                        : key === "p99LatencyMs"
                                          ? "var(--color-p99LatencyMs)"
                                          : isRatio
                                            ? key === "blockedRatio"
                                              ? "var(--color-blockedRatio)"
                                              : "var(--color-botRatio)"
                                            : "var(--color-count)";

    return (
      <TrendTooltipValue
        color={indicatorColor}
        label={label}
        value={formatted}
      />
    );
  };
}

function createTrendChartConfig(
  labels: RequestObservationTrendLabels,
): ChartConfig {
  return {
    normalCount: {
      label: labels.normalRequests,
      color: NORMAL_TRAFFIC_SHARE_COLOR,
    },
    suspectedBotCount: {
      label: labels.suspectedBotRequests,
      color: SUSPECTED_BOT_TRAFFIC_COLOR,
    },
    botCount: {
      label: labels.botRequests,
      color: BOT_TRAFFIC_COLOR,
    },
    customBlockedCount: {
      label: labels.customBlockedRequests,
      color: CUSTOM_BLOCKED_TRAFFIC_COLOR,
    },
    includedCount: {
      label: labels.includedRequests,
      color: NORMAL_TRAFFIC_SHARE_COLOR,
    },
    blockedCount: {
      label: labels.blockedRequests,
      color: "var(--color-destructive)",
    },
    totalCount: {
      label: labels.totalRequests,
      color: "var(--color-chart-1)",
    },
    pageviews: {
      label: labels.pageviews,
      color: NORMAL_TRAFFIC_SHARE_COLOR,
    },
    customEvents: {
      label: labels.customEvents,
      color: PERFORMANCE_WARNING_COLOR,
    },
    pageviewCount: {
      label: labels.pageview,
      color: "var(--color-chart-1)",
    },
    leaveCount: {
      label: labels.leave,
      color: "var(--color-chart-2)",
    },
    visibilityCount: {
      label: labels.visibility,
      color: "var(--color-chart-3)",
    },
    customEventCount: {
      label: labels.customEvent,
      color: BUSINESS_CUSTOM_EVENT_COLOR,
    },
    identifyCount: {
      label: labels.identify,
      color: BUSINESS_IDENTIFY_COLOR,
    },
    botRatio: {
      label: labels.botRatio,
      color: BOT_TRAFFIC_COLOR,
    },
    blockedRatio: {
      label: labels.blockedRatio,
      color: "var(--color-destructive)",
    },
    normalRatio: {
      label: labels.normalRatio,
      color: NORMAL_TRAFFIC_SHARE_COLOR,
    },
    avgLatencyMs: {
      label: labels.avgLatency,
      color: "var(--color-chart-1)",
    },
    p50LatencyMs: {
      label: labels.p50Latency,
      color: "var(--color-chart-1)",
    },
    p75LatencyMs: {
      label: labels.p75Latency,
      color: "var(--color-chart-4)",
    },
    p95LatencyMs: {
      label: labels.p95Latency,
      color: "var(--color-chart-5)",
    },
    p99LatencyMs: {
      label: labels.p99Latency,
      color: "var(--color-destructive)",
    },
    normalTrafficShare: {
      label: labels.normalTrafficShare,
      color: NORMAL_TRAFFIC_SHARE_COLOR,
    },
  };
}

function RequestObservationTrendChartComponent({
  className,
  data,
  labels,
  latencyFormatter,
  locale,
  spanMs,
  variant,
}: RequestObservationTrendChartProps) {
  const chartData = useMemo(() => Array.from(data), [data]);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(intlLocale(locale)),
    [locale],
  );
  const trendTickFormatter = useMemo(
    () => trendTickDateFormat(locale, spanMs),
    [locale, spanMs],
  );
  const trendTooltipFormatter = useMemo(
    () => trendTooltipDateFormat(locale, spanMs),
    [locale, spanMs],
  );
  const formatTrendTooltipValue = useMemo(
    () =>
      createTrendTooltipFormatter({
        labels,
        latencyFormatter:
          latencyFormatter ??
          ((valueMs: number) => durationFormat(locale, valueMs)),
        locale,
      }),
    [labels, latencyFormatter, locale],
  );
  const trendConfig = useMemo(() => createTrendChartConfig(labels), [labels]);
  const isLatency = variant === "latency";
  const isLargeTrend =
    variant === "overview" || variant === "blocked" || variant === "included";
  const formatLatency =
    latencyFormatter ?? ((valueMs: number) => durationFormat(locale, valueMs));

  return (
    <ChartContainer config={trendConfig} className={cn("w-full", className)}>
      <ComposedChart data={chartData}>
        {variant === "traffic-composition" ? (
          <defs>
            <linearGradient
              id="request-observability-pageview-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-pageviewCount)"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="var(--color-pageviewCount)"
                stopOpacity={0.02}
              />
            </linearGradient>
            <linearGradient
              id="request-observability-leave-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-leaveCount)"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="var(--color-leaveCount)"
                stopOpacity={0.02}
              />
            </linearGradient>
            <linearGradient
              id="request-observability-visibility-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-visibilityCount)"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="var(--color-visibilityCount)"
                stopOpacity={0.02}
              />
            </linearGradient>
            <linearGradient
              id="request-observability-custom-event-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-customEventCount)"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="var(--color-customEventCount)"
                stopOpacity={0.02}
              />
            </linearGradient>
            <linearGradient
              id="request-observability-identify-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor="var(--color-identifyCount)"
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor="var(--color-identifyCount)"
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
        ) : null}
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="timestampMs"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value) =>
            trendTickFormatter.format(new Date(Number(value ?? 0)))
          }
          minTickGap={14}
        />
        {isLargeTrend ? (
          <YAxis
            yAxisId="requests"
            width={52}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => numberFormatter.format(Number(value))}
          />
        ) : null}
        {isLargeTrend ? (
          <YAxis
            yAxisId="ratio"
            orientation="right"
            width={44}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => percentFormat(locale, Number(value))}
          />
        ) : null}
        {!isLargeTrend ? (
          <YAxis
            width={isLatency ? 60 : 52}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) =>
              isLatency
                ? formatLatency(Number(value))
                : numberFormatter.format(Number(value))
            }
          />
        ) : null}
        {isLargeTrend ? (
          <Customized component={RequestObservationHoverHighlight} />
        ) : null}
        <ChartTooltip
          cursor={isLargeTrend ? false : undefined}
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 20 }}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(value, payload) => {
                const timestamp = Number(
                  payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                );
                return trendTooltipFormatter.format(new Date(timestamp));
              }}
              formatter={formatTrendTooltipValue}
            />
          }
        />
        {variant === "overview" ? (
          <Bar
            yAxisId="requests"
            dataKey="normalCount"
            stackId="requests"
            fill="var(--color-normalCount)"
            radius={[0, 0, 0, 0]}
          />
        ) : null}
        {variant === "overview" ? (
          <Bar
            yAxisId="requests"
            dataKey="suspectedBotCount"
            stackId="requests"
            fill="var(--color-suspectedBotCount)"
            radius={[0, 0, 0, 0]}
          />
        ) : null}
        {variant === "overview" ? (
          <Bar
            yAxisId="requests"
            dataKey="botCount"
            stackId="requests"
            fill="var(--color-botCount)"
            radius={[0, 0, 0, 0]}
          />
        ) : null}
        {variant === "overview" ? (
          <Bar
            yAxisId="requests"
            dataKey="customBlockedCount"
            stackId="requests"
            fill="var(--color-customBlockedCount)"
            radius={[0, 0, 0, 0]}
          />
        ) : null}
        {variant === "overview" ? (
          <Line
            yAxisId="ratio"
            type="linear"
            dataKey="blockedRatio"
            stroke="var(--color-blockedRatio)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ) : null}
        {variant === "traffic-composition" ? (
          <Area
            type="linear"
            dataKey="pageviewCount"
            stroke="var(--color-pageviewCount)"
            fill="url(#request-observability-pageview-fill)"
            strokeWidth={2}
            dot={false}
          />
        ) : null}
        {variant === "traffic-composition" ? (
          <Area
            type="linear"
            dataKey="leaveCount"
            stroke="var(--color-leaveCount)"
            fill="url(#request-observability-leave-fill)"
            strokeWidth={2}
            dot={false}
          />
        ) : null}
        {variant === "traffic-composition" ? (
          <Area
            type="linear"
            dataKey="visibilityCount"
            stroke="var(--color-visibilityCount)"
            fill="url(#request-observability-visibility-fill)"
            strokeWidth={2}
            dot={false}
          />
        ) : null}
        {variant === "traffic-composition" ? (
          <Area
            type="linear"
            dataKey="customEventCount"
            stroke="var(--color-customEventCount)"
            fill="url(#request-observability-custom-event-fill)"
            strokeWidth={2}
            dot={false}
          />
        ) : null}
        {variant === "traffic-composition" ? (
          <Area
            type="linear"
            dataKey="identifyCount"
            stroke="var(--color-identifyCount)"
            fill="url(#request-observability-identify-fill)"
            strokeWidth={2}
            dot={false}
          />
        ) : null}
        {variant === "latency" ? (
          <Line
            type="linear"
            dataKey="p50LatencyMs"
            stroke="var(--color-p50LatencyMs)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ) : null}
        {variant === "latency" ? (
          <Line
            type="linear"
            dataKey="p75LatencyMs"
            stroke="var(--color-p75LatencyMs)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ) : null}
        {variant === "latency" ? (
          <Line
            type="linear"
            dataKey="p95LatencyMs"
            stroke="var(--color-p95LatencyMs)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ) : null}
        {variant === "latency" ? (
          <Line
            type="linear"
            dataKey="p99LatencyMs"
            stroke="var(--color-p99LatencyMs)"
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
          />
        ) : null}
        {variant === "blocked" ? (
          <Bar
            yAxisId="requests"
            dataKey="blockedCount"
            fill="var(--color-blockedCount)"
            radius={[3, 3, 0, 0]}
          />
        ) : null}
        {variant === "blocked" ? (
          <Line
            yAxisId="ratio"
            type="linear"
            dataKey="blockedRatio"
            stroke="var(--color-blockedRatio)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ) : null}
        {variant === "included" ? (
          <Bar
            yAxisId="requests"
            dataKey="includedCount"
            fill="var(--color-includedCount)"
            radius={[3, 3, 0, 0]}
          />
        ) : null}
      </ComposedChart>
    </ChartContainer>
  );
}

export const RequestObservationTrendChart = memo(
  RequestObservationTrendChartComponent,
);
