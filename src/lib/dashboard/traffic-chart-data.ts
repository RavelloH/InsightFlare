import type { DashboardInterval } from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";

export interface TrafficChartPoint {
  timestampMs: number;
  views: number;
  visitors: number;
}

export function safeChartCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function intervalStepMs(interval: DashboardInterval): number {
  if (interval === "minute") return 60_000;
  if (interval === "hour") return 60 * 60_000;
  if (interval === "day") return 24 * 60 * 60_000;
  if (interval === "week") return 7 * 24 * 60 * 60_000;
  return 30 * 24 * 60 * 60_000;
}

export function fillMissingTrafficData(
  data: TrafficChartPoint[],
  interval: DashboardInterval,
  timeZone: string,
  range?: {
    from: number;
    to: number;
  },
): TrafficChartPoint[] {
  if (data.length === 0) return data;

  const bucketMap = new Map<number, TrafficChartPoint>();

  for (const point of data) {
    const bucketStart = startOfZonedInterval(
      Number(point.timestampMs ?? 0),
      interval,
      timeZone,
    );
    const current = bucketMap.get(bucketStart) ?? {
      timestampMs: bucketStart,
      views: 0,
      visitors: 0,
    };
    current.views += safeChartCount(point.views);
    current.visitors += safeChartCount(point.visitors);
    bucketMap.set(bucketStart, current);
  }

  const sortedStarts = [...bucketMap.keys()].sort(
    (left, right) => left - right,
  );
  const fallbackFrom = sortedStarts[0] ?? 0;
  const fallbackTo = sortedStarts[sortedStarts.length - 1] ?? fallbackFrom;
  const rangeFrom =
    Number.isFinite(range?.from) && Number(range?.from) > 0
      ? startOfZonedInterval(Number(range?.from ?? 0), interval, timeZone)
      : fallbackFrom;
  const rangeTo = Number.isFinite(range?.to)
    ? startOfZonedInterval(Number(range?.to ?? 0), interval, timeZone)
    : fallbackTo;
  const from = Math.min(rangeFrom, fallbackFrom);
  const to = Math.max(from, Math.max(rangeTo, fallbackTo));

  const filled: TrafficChartPoint[] = [];
  const hardLimit = 2000;
  let current = from;
  for (let index = 0; index < hardLimit && current <= to; index += 1) {
    filled.push(
      bucketMap.get(current) ?? {
        timestampMs: current,
        views: 0,
        visitors: 0,
      },
    );
    let next = addZonedInterval(current, interval, timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalStepMs(interval);
    }
    current = next;
  }

  return filled;
}

export function downsampleTrafficData(
  data: TrafficChartPoint[],
  maxPoints: number,
): TrafficChartPoint[] {
  if (
    !Number.isFinite(maxPoints) ||
    maxPoints <= 0 ||
    data.length <= maxPoints
  ) {
    return data;
  }

  const chunkSize = Math.ceil(data.length / maxPoints);
  const next: TrafficChartPoint[] = [];

  for (let index = 0; index < data.length; index += chunkSize) {
    const chunk = data.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;

    const timestampMs = chunk[chunk.length - 1]?.timestampMs ?? 0;
    let views = 0;
    let visitors = 0;

    for (const point of chunk) {
      views += safeChartCount(point.views);
      visitors += safeChartCount(point.visitors);
    }

    next.push({
      timestampMs,
      views,
      visitors: Math.min(visitors, views),
    });
  }

  return next;
}
