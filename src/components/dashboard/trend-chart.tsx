"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import { intlLocale } from "@/lib/dashboard/format";

interface TrendChartPoint {
  timestampMs: number;
  views: number;
  sessions: number;
}

interface TrendChartProps {
  locale: Locale;
  interval: DashboardInterval;
  data: TrendChartPoint[];
  viewsLabel: string;
  sessionsLabel: string;
}

function useChartVisibility(rootMargin = "120px 0px") {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasMeasuredVisibility, setHasMeasuredVisibility] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      setHasMeasuredVisibility(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        setIsVisible(nextVisible);
        setHasMeasuredVisibility(true);
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  return {
    containerRef,
    isVisible,
    hasMeasuredVisibility,
  };
}

function useAnimationOnChartSwitch({
  switchKey,
  hasData,
  isVisible,
  hasMeasuredVisibility,
}: {
  switchKey: string;
  hasData: boolean;
  isVisible: boolean;
  hasMeasuredVisibility: boolean;
}): boolean {
  const appliedKeyRef = useRef<string | null>(null);
  const animationEnabledRef = useRef(false);

  if (appliedKeyRef.current !== switchKey && hasMeasuredVisibility) {
    appliedKeyRef.current = switchKey;
    animationEnabledRef.current = hasData && isVisible;
  }

  if (appliedKeyRef.current !== switchKey) {
    return hasData && isVisible;
  }

  return animationEnabledRef.current;
}

function tickDateFormat(localeCode: string, interval: DashboardInterval): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      year: "numeric",
      month: "short",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    month: "short",
    day: "numeric",
  });
}

function tooltipDateFormat(localeCode: string, interval: DashboardInterval): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      year: "numeric",
      month: "long",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function TrendChart({
  locale,
  interval,
  data,
  viewsLabel,
  sessionsLabel,
}: TrendChartProps) {
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility();
  const localeCode = intlLocale(locale);
  const axisTickFormatter = tickDateFormat(localeCode, interval);
  const tooltipFormatter = tooltipDateFormat(localeCode, interval);
  const config = {
    nonSessionViews: {
      label: viewsLabel,
      color: "var(--color-chart-1)",
    },
    sessions: {
      label: sessionsLabel,
      color: "var(--color-chart-2)",
    },
  } satisfies ChartConfig;

  const chartData = data.map((point) => ({
    timestampMs: point.timestampMs,
    sessions: Math.max(0, Math.round(point.sessions)),
    views: Math.max(0, Math.round(point.views)),
  })).map((point) => {
    const sessions = Math.min(point.sessions, point.views);
    return {
      ...point,
      sessions,
      nonSessionViews: Math.max(0, point.views - sessions),
    };
  });
  const chartDataKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${interval}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [chartData, interval]);
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: chartDataKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef}>
      <ChartContainer className="h-[280px] w-full aspect-auto" config={config}>
        <BarChart
          data={chartData}
          margin={{ left: 8, right: 8, top: 4 }}
          barGap={0}
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
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <ChartTooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 20 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(value, payload) => {
                  const timestamp = Number(
                    payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                  );
                  return tooltipFormatter.format(new Date(timestamp));
                }}
                formatter={(value, name, _item, _index, payload) => {
                  const isViews = name === "nonSessionViews";
                  const label = isViews ? viewsLabel : sessionsLabel;
                  const row = (payload ?? null) as
                    | { views?: number; sessions?: number }
                    | null;
                  const numeric = isViews
                    ? Number(row?.views ?? 0)
                    : typeof value === "number"
                      ? value
                      : Number(value ?? 0);
                  const indicatorColor = isViews
                    ? "var(--color-nonSessionViews)"
                    : "var(--color-sessions)";
                  return (
                    <div className="flex min-w-32 items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: indicatorColor }}
                        />
                        <span className="text-muted-foreground">{label}</span>
                      </span>
                      <span className="font-mono text-foreground tabular-nums">
                        {numeric.toLocaleString(localeCode)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent className="pt-4" />} />
          <Bar
            dataKey="sessions"
            stackId="traffic"
            fill="var(--color-sessions)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 260 : 0}
          />
          <Bar
            dataKey="nonSessionViews"
            stackId="traffic"
            fill="var(--color-nonSessionViews)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 260 : 0}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
