import { useMemo } from "react";
import {
  type GoalTimeseriesChartPoint,
  type GoalTimeseriesMetric,
  GoalTimeseriesView,
} from "@insightflare/product-ui/goals";

import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { GoalTimeseriesPoint } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildGoalTimeseriesLabels } from "@/lib/product-ui-labels/goals";
type GoalChartMetric = GoalTimeseriesMetric;
type GoalChartPoint = GoalTimeseriesChartPoint;
interface GoalComparisonChartPoint extends GoalChartPoint {
  comparisonSessions: GoalChartMetric;
  comparisonSessionsRate: number;
  comparisonVisitors: GoalChartMetric;
  comparisonVisitorsRate: number;
}
function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function safeMetric(metric?: GoalTimeseriesPoint["visitors"]): GoalChartMetric {
  const total = safeCount(Number(metric?.total ?? 0));
  const converted = Math.min(total, safeCount(Number(metric?.converted ?? 0)));
  return {
    converted,
    rate:
      total > 0
        ? converted / total
        : Number.isFinite(metric?.conversionRate)
          ? Math.min(1, Math.max(0, metric?.conversionRate ?? 0))
          : 0,
    total,
  };
}
function mergeMetric(
  left: GoalChartMetric,
  right: GoalChartMetric,
): GoalChartMetric {
  const total = left.total + right.total;
  const converted = Math.min(total, left.converted + right.converted);
  return {
    converted,
    rate: total > 0 ? converted / total : 0,
    total,
  };
}
function createGoalChartPoint(
  timestampMs: number,
  sessions?: GoalChartMetric,
  visitors?: GoalChartMetric,
): GoalChartPoint {
  const nextSessions = sessions ?? { converted: 0, rate: 0, total: 0 };
  const nextVisitors = visitors ?? { converted: 0, rate: 0, total: 0 };
  return {
    sessions: nextSessions,
    sessionsRate: nextSessions.rate,
    timestampMs,
    visitors: nextVisitors,
    visitorsRate: nextVisitors.rate,
  };
}
function intervalStepMs(interval: DashboardInterval): number {
  if (interval === "minute") return 60 * 1_000;
  if (interval === "hour") return 60 * 60 * 1_000;
  if (interval === "day") return 24 * 60 * 60 * 1_000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1_000;
  return 30 * 24 * 60 * 60 * 1_000;
}
function createGoalComparisonChartData(
  current: readonly GoalChartPoint[],
  comparison: readonly GoalChartPoint[],
): GoalComparisonChartPoint[] {
  return current.map((point, index) => {
    const comparisonPoint = comparison[index] ?? createGoalChartPoint(0);
    return {
      ...point,
      comparisonSessions: comparisonPoint.sessions,
      comparisonSessionsRate: comparisonPoint.sessionsRate,
      comparisonVisitors: comparisonPoint.visitors,
      comparisonVisitorsRate: comparisonPoint.visitorsRate,
    };
  });
}
export function normalizeGoalTimeseries(
  points: readonly GoalTimeseriesPoint[],
  from: number,
  to: number,
  interval: DashboardInterval,
  timeZone: string,
): GoalChartPoint[] {
  const safeFrom = Number.isFinite(from) ? from : (points[0]?.timestampMs ?? 0);
  const start = startOfZonedInterval(safeFrom, interval, timeZone);
  const safeTo = Number.isFinite(to)
    ? Math.max(safeFrom, to)
    : points.at(-1)?.timestampMs !== undefined
      ? addZonedInterval(
          startOfZonedInterval(points.at(-1)!.timestampMs, interval, timeZone),
          interval,
          timeZone,
        )
      : safeFrom;
  const pointByBucket = new Map<number, GoalChartPoint>();

  for (const point of points) {
    const timestampMs = Number(point.timestampMs);
    if (!Number.isFinite(timestampMs)) continue;
    const bucket = startOfZonedInterval(timestampMs, interval, timeZone);
    if (bucket < start || bucket >= safeTo) continue;
    const previous = pointByBucket.get(bucket);
    const sessions = safeMetric(point.sessions);
    const visitors = safeMetric(point.visitors);
    pointByBucket.set(
      bucket,
      previous
        ? createGoalChartPoint(
            bucket,
            mergeMetric(previous.sessions, sessions),
            mergeMetric(previous.visitors, visitors),
          )
        : createGoalChartPoint(bucket, sessions, visitors),
    );
  }

  const normalized: GoalChartPoint[] = [];
  const hardLimit = 2_000;
  let current = start;
  for (let index = 0; index < hardLimit && current < safeTo; index += 1) {
    normalized.push(
      pointByBucket.get(current) ?? createGoalChartPoint(current),
    );
    let next = addZonedInterval(current, interval, timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalStepMs(interval);
    }
    current = next;
  }
  return normalized;
}
export function GoalTimeseriesChart({
  points,
  locale,
  labels,
  from,
  to,
  timeZone,
  interval,
  loading = false,
  comparisonPoints,
  comparisonFrom,
  comparisonTo,
  comparisonLabel,
}: {
  readonly points: readonly GoalTimeseriesPoint[];
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly from: number;
  readonly to: number;
  readonly timeZone: string;
  readonly interval: DashboardInterval;
  readonly loading?: boolean;
  readonly comparisonPoints?: readonly GoalTimeseriesPoint[];
  readonly comparisonFrom?: number;
  readonly comparisonTo?: number;
  readonly comparisonLabel?: string;
}) {
  const hasComparison =
    comparisonPoints !== undefined &&
    comparisonFrom !== undefined &&
    comparisonTo !== undefined;
  const chartData = useMemo(() => {
    const current = normalizeGoalTimeseries(
      loading ? [] : points,
      from,
      to,
      interval,
      timeZone,
    );
    if (!hasComparison) return current;

    const comparison = normalizeGoalTimeseries(
      loading ? [] : (comparisonPoints ?? []),
      comparisonFrom,
      comparisonTo,
      interval,
      timeZone,
    );
    return createGoalComparisonChartData(current, comparison);
  }, [
    comparisonFrom,
    comparisonPoints,
    comparisonTo,
    from,
    hasComparison,
    interval,
    loading,
    points,
    timeZone,
    to,
  ]);
  const viewLabels = useMemo(() => buildGoalTimeseriesLabels(labels), [labels]);
  return (
    <GoalTimeseriesView
      data={chartData}
      labels={viewLabels}
      locale={locale}
      timeZone={timeZone}
      interval={interval}
      loading={loading}
      hasComparison={hasComparison}
      comparisonLabel={comparisonLabel}
    />
  );
}
