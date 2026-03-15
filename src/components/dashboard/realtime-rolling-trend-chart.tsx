"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

export interface RealtimeRollingTrendPoint {
  timestampMs: number;
  views: number;
  sessions: number;
}

interface RealtimeRollingTrendChartProps {
  locale: Locale;
  data: RealtimeRollingTrendPoint[];
  viewsLabel: string;
  sessionsLabel: string;
  className?: string;
}

interface AnimatedTrendPoint extends RealtimeRollingTrendPoint {}

const ANIMATION_DURATION_MS = 300;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

function equalTrendData(
  left: RealtimeRollingTrendPoint[],
  right: RealtimeRollingTrendPoint[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftPoint = left[index];
    const rightPoint = right[index];
    if (!leftPoint || !rightPoint) return false;
    if (
      leftPoint.timestampMs !== rightPoint.timestampMs ||
      leftPoint.views !== rightPoint.views ||
      leftPoint.sessions !== rightPoint.sessions
    ) {
      return false;
    }
  }
  return true;
}

function buildAnimationOrigin(
  previous: AnimatedTrendPoint[],
  target: RealtimeRollingTrendPoint[],
): AnimatedTrendPoint[] {
  const previousByTimestamp = new Map(
    previous.map((point) => [point.timestampMs, point] as const),
  );

  return target.map((point, index) => {
    const matched = previousByTimestamp.get(point.timestampMs);
    const fallback = previous[index];
    return {
      timestampMs: point.timestampMs,
      views: matched?.views ?? fallback?.views ?? 0,
      sessions: matched?.sessions ?? fallback?.sessions ?? 0,
    };
  });
}

export function RealtimeRollingTrendChart({
  locale,
  data,
  viewsLabel,
  sessionsLabel,
  className,
}: RealtimeRollingTrendChartProps) {
  const gradientId = useId().replace(/:/g, "");
  const [displayData, setDisplayData] = useState<AnimatedTrendPoint[]>(() =>
    data.map((point) => ({
      timestampMs: point.timestampMs,
      views: point.views,
      sessions: point.sessions,
    })),
  );
  const displayDataRef = useRef(displayData);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    displayDataRef.current = displayData;
  }, [displayData]);

  useEffect(() => {
    if (equalTrendData(displayDataRef.current, data)) return;

    const from = buildAnimationOrigin(displayDataRef.current, data);
    const target = data.map((point) => ({
      timestampMs: point.timestampMs,
      views: point.views,
      sessions: point.sessions,
    }));

    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = clamp(
        (now - startedAt) / ANIMATION_DURATION_MS,
        0,
        1,
      );
      const eased = easeOutCubic(progress);
      const next = target.map((point, index) => {
        const base = from[index];
        return {
          timestampMs: point.timestampMs,
          views: lerp(base?.views ?? 0, point.views, eased),
          sessions: lerp(base?.sessions ?? 0, point.sessions, eased),
        };
      });

      displayDataRef.current = next;
      setDisplayData(next);

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(tick);
        return;
      }

      animationFrameRef.current = null;
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [data]);

  const localeCode = intlLocale(locale);
  const tickFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(localeCode, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [localeCode],
  );
  const tooltipDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(localeCode, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [localeCode],
  );
  const yAxisTickFormatter = useMemo(
    () => (value: number | string) => numberFormat(locale, Math.round(Number(value ?? 0))),
    [locale],
  );
  const chartConfig = useMemo(
    () =>
      ({
        sessions: {
          label: sessionsLabel,
          color: "var(--color-chart-2)",
        },
        nonSessionViews: {
          label: viewsLabel,
          color: "var(--color-chart-1)",
        },
      }) satisfies ChartConfig,
    [sessionsLabel, viewsLabel],
  );
  const chartData = useMemo(
    () =>
      displayData.map((point) => {
        const views = Math.max(0, point.views);
        const sessions = Math.min(Math.max(0, point.sessions), views);
        return {
          timestampMs: point.timestampMs,
          views,
          sessions,
          nonSessionViews: Math.max(0, views - sessions),
        };
      }),
    [displayData],
  );

  return (
    <ChartContainer
      config={chartConfig}
      className={cn("aspect-auto h-[280px] w-full", className)}
    >
      <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient
            id={`${gradientId}-sessions`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop
              offset="5%"
              stopColor="var(--color-sessions)"
              stopOpacity={0.8}
            />
            <stop
              offset="95%"
              stopColor="var(--color-sessions)"
              stopOpacity={0.12}
            />
          </linearGradient>
          <linearGradient
            id={`${gradientId}-views`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop
              offset="5%"
              stopColor="var(--color-nonSessionViews)"
              stopOpacity={0.72}
            />
            <stop
              offset="95%"
              stopColor="var(--color-nonSessionViews)"
              stopOpacity={0.08}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="timestampMs"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) =>
            tickFormatter.format(new Date(Number(value ?? 0)))
          }
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={yAxisTickFormatter}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(value, payload) => {
                const timestamp = Number(
                  payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                );
                return tooltipDateFormatter.format(new Date(timestamp));
              }}
              formatter={(value, name, _item, _index, payload) => {
                const isViews = name === "nonSessionViews";
                const label = isViews ? viewsLabel : sessionsLabel;
                const row = (payload ?? null) as
                  | { views?: number; sessions?: number }
                  | null;
                const numeric = isViews
                  ? Number(row?.views ?? 0)
                  : Number(row?.sessions ?? value ?? 0);
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
        <Area
          dataKey="sessions"
          type="step"
          stackId="traffic"
          stroke="var(--color-sessions)"
          fill={`url(#${gradientId}-sessions)`}
          isAnimationActive={false}
        />
        <Area
          dataKey="nonSessionViews"
          type="step"
          stackId="traffic"
          stroke="var(--color-nonSessionViews)"
          fill={`url(#${gradientId}-views)`}
          isAnimationActive={false}
        />
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  );
}
