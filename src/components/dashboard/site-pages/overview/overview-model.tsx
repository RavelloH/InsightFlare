import { memo } from "react";
import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { OverviewData, TrendData } from "@/lib/dashboard-api/client/edge";
import { cn } from "@/lib/utils";
export function toDeltaPercent(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
export function emptyOverviewData(): OverviewData {
  return {
    ok: true,
    data: {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
    },
  };
}
export function emptyTrendData(interval: TimeWindow["interval"]): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}
export const EMPTY_TREND_POINTS: TrendData["data"] = [];
export function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}
export const METRIC_AREA_COLOR = "var(--color-chart-1)";
export const COMPARISON_AREA_COLOR = "var(--color-compare-chart-1)";
const MAX_TREND_PLACEHOLDER_POINTS = 120;
function trendStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}
export function buildEmptyTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
): Array<{
  timestampMs: number;
  views: number;
  visitors: number;
}> {
  const starts: number[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );
  const hardLimit = 2000;
  for (let index = 0; index < hardLimit && current <= end; index += 1) {
    starts.push(current);
    let next = addZonedInterval(current, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + trendStepMs(window.interval);
    }
    current = next;
  }

  const stride = Math.max(
    1,
    Math.ceil(starts.length / MAX_TREND_PLACEHOLDER_POINTS),
  );
  const points: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }> = [];

  for (let index = 0; index < starts.length; index += stride) {
    const timestampMs = starts[index] ?? 0;
    points.push({
      timestampMs,
      views: 0,
      visitors: 0,
    });
  }

  const lastTimestampMs = starts[starts.length - 1] ?? 0;
  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      views: 0,
      visitors: 0,
    });
  }

  return points;
}
export function normalizeTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
  points: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }>,
): Array<{
  timestampMs: number;
  views: number;
  visitors: number;
}> {
  const byBucket = new Map<number, { views: number; visitors: number }>();
  const start = startOfZonedInterval(
    window.from,
    window.interval,
    window.timeZone,
  );
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);

  for (const point of points) {
    const bucket = startOfZonedInterval(
      Number(point.timestampMs ?? 0),
      window.interval,
      window.timeZone,
    );
    if (!Number.isFinite(bucket) || bucket < start || bucket > end) {
      continue;
    }
    const prev = byBucket.get(bucket) ?? { views: 0, visitors: 0 };
    byBucket.set(bucket, {
      views: prev.views + Math.max(0, Number(point.views ?? 0)),
      visitors: prev.visitors + Math.max(0, Number(point.visitors ?? 0)),
    });
  }

  const normalized: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }> = [];
  const hardLimit = 2000;
  for (
    let index = 0, bucket = start;
    index < hardLimit && bucket <= end;
    index += 1
  ) {
    const value = byBucket.get(bucket);
    normalized.push({
      timestampMs: bucket,
      views: value?.views ?? 0,
      visitors: value?.visitors ?? 0,
    });
    let next = addZonedInterval(bucket, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= bucket) {
      next = bucket + trendStepMs(window.interval);
    }
    bucket = next;
  }

  return normalized;
}
export function metricCellBorderClasses(index: number): string {
  // Mobile (1-col): top border for all except first
  const mobileHasTop = index >= 1;
  // md (2-col): left border on odd indices, top border for row 2+
  const mdHasLeft = index % 2 !== 0;
  const mdHasTop = index >= 2;
  // lg (3-col): left border on col 2/3, top border for row 2+
  const lgHasLeft = index % 3 !== 0;
  const lgHasTop = index >= 3;

  return cn(
    mobileHasTop ? "border-t" : "",
    // md (2-col): reset mobile top for row 2+, apply left + top
    mdHasTop ? "md:border-t" : "md:border-t-0",
    mdHasLeft ? "md:border-l" : "md:border-l-0",
    // lg (3-col): override md borders
    lgHasTop ? "lg:border-t" : "lg:border-t-0",
    lgHasLeft ? "lg:border-l" : "lg:border-l-0",
  );
}
export function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
export function changeRateClass(
  value: number | null,
  lowerIsBetter = false,
): string {
  if (value === null) return "text-muted-foreground";
  const isImprovement = lowerIsBetter ? value <= 0 : value >= 0;
  return isImprovement ? "text-emerald-600" : "text-rose-600";
}
export const ChangeRateInline = memo(function ChangeRateInline({
  value,
  lowerIsBetter = false,
}: {
  value: number | null;
  lowerIsBetter?: boolean;
}) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value, lowerIsBetter)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
});
