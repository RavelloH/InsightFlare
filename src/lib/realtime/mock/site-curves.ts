// ---------------------------------------------------------------------------
//  Per-site deterministic traffic curve and metric integration
//
//  Each site has an hourProfile { riseHour, activeWidth, baseLevel } that
//  defines a unique 24h traffic shape:
//    - Active zone [riseHour, riseHour + activeWidth]: sine peak
//    - Outside: flat at baseLevel
//    - Supports midnight wrapping (riseHour + activeWidth > 24)
//
//  r(t) = dailyViewCount(day) × siteHourShape(hourOfDay) / siteDayIntegral
//
//  Views for any [from, to] = Σ over each overlapping day d:
//    dailyViewCount(siteId, d) × siteHourShapeIntegral(h1, h2, ...) / siteDayIntegral(siteId)
//
//  Guarantees:
//    1. Same window → same result (deterministic)
//    2. Sub-windows sum to parent window (additive)
//    3. Data changes with time window (integration-dependent)
//    4. Each site has a distinct 24h curve shape
// ---------------------------------------------------------------------------

import { findSiteProfile } from "@/lib/realtime/demo-site-profiles";
import { fnv1a, mulberry32, sFloat, sInt } from "@/lib/realtime/demo-utils";

/**
 * Closed-form integral of a per-site hour shape over [h1, h2] (hour-of-day, 0–24).
 *
 * Shape: baseLevel outside active zone; baseLevel + (1-baseLevel)·sin(phase·π/activeWidth) inside.
 * Active zone wraps around midnight when riseHour + activeWidth > 24.
 */
export function siteHourShapeIntegral(
  h1: number,
  h2: number,
  riseHour: number,
  activeWidth: number,
  baseLevel: number,
): number {
  if (h1 >= h2) return 0;
  const constPart = baseLevel * (h2 - h1);
  const endHour = riseHour + activeWidth;

  const segments: Array<[number, number, number]> = [];
  if (endHour <= 24) {
    segments.push([riseHour, endHour, 0]);
  } else {
    segments.push([riseHour, 24, 0]);
    segments.push([0, endHour - 24, 24]);
  }

  let sinPart = 0;
  const k = Math.PI / activeWidth;
  for (const [segStart, segEnd, offset] of segments) {
    const oStart = Math.max(h1, segStart);
    const oEnd = Math.min(h2, segEnd);
    if (oStart >= oEnd) continue;
    sinPart +=
      (1 / k) *
      (Math.cos((oStart - riseHour + offset) * k) -
        Math.cos((oEnd - riseHour + offset) * k));
  }

  return constPart + (1 - baseLevel) * sinPart;
}

const _siteDayIntegralCache = new Map<string, number>();

/** Cached full-day integral for a site's hour shape */
export function siteDayIntegral(siteId: string): number {
  const cached = _siteDayIntegralCache.get(siteId);
  if (cached !== undefined) return cached;
  const hp = findSiteProfile(siteId).hourProfile;
  const val = siteHourShapeIntegral(
    0,
    24,
    hp.riseHour,
    hp.activeWidth,
    hp.baseLevel,
  );
  _siteDayIntegralCache.set(siteId, val);
  return val;
}

/** Deterministic daily view count for a site on a given day number (since epoch) */
export function dailyViewCount(siteId: string, dayNum: number): number {
  const profile = findSiteProfile(siteId);
  const rng = mulberry32(fnv1a(`${siteId}:day:${dayNum}`));
  let pv = sInt(rng, profile.dailyPvRange[0], profile.dailyPvRange[1]);
  // 1970-01-01 (dayNum 0) = Thursday (dow 4). 0=Sun…6=Sat
  const dow = (4 + (((dayNum % 7) + 7) % 7)) % 7;
  if (dow === 0 || dow === 6) pv = Math.round(pv * profile.weekendFactor);
  return pv;
}

/** Integrate views for a site over [fromMs, toMs) using per-site hour shape */
export function integrateViews(
  siteId: string,
  fromMs: number,
  toMs: number,
): number {
  if (fromMs >= toMs) return 0;
  const HOUR_MS = 3600000;
  const DAY_H = 24;
  const fromH = fromMs / HOUR_MS;
  const toH = toMs / HOUR_MS;
  const fromDay = Math.floor(fromH / DAY_H);
  const toDay = Math.floor((toH - 1e-9) / DAY_H);
  const hp = findSiteProfile(siteId).hourProfile;
  const dayInt = siteDayIntegral(siteId);
  let total = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const dayStartH = d * DAY_H;
    const h1 = Math.max(fromH - dayStartH, 0);
    const h2 = Math.min(toH - dayStartH, DAY_H);
    if (h1 >= h2) continue;
    total +=
      (dailyViewCount(siteId, d) *
        siteHourShapeIntegral(
          h1,
          h2,
          hp.riseHour,
          hp.activeWidth,
          hp.baseLevel,
        )) /
      dayInt;
  }
  return Math.round(total);
}

export interface SiteMetricRatios {
  sessionsPerView: number;
  visitorsPerSession: number;
  bounceRate: number;
  avgDurationMs: number;
}

const _siteRatiosCache = new Map<string, SiteMetricRatios>();

/** Per-site metric ratios — deterministic, fixed for each site */
export function siteRatios(siteId: string): SiteMetricRatios {
  const cached = _siteRatiosCache.get(siteId);
  if (cached) return cached;
  const profile = findSiteProfile(siteId);
  const rng = mulberry32(fnv1a(`${siteId}:ratios`));
  const ratios: SiteMetricRatios = {
    sessionsPerView: 0.4 + rng() * 0.25,
    visitorsPerSession: 0.65 + rng() * 0.25,
    bounceRate: sFloat(
      rng,
      profile.bounceRateRange[0],
      profile.bounceRateRange[1],
    ),
    avgDurationMs: sInt(
      rng,
      profile.avgDurationMsRange[0],
      profile.avgDurationMsRange[1],
    ),
  };
  _siteRatiosCache.set(siteId, ratios);
  return ratios;
}

/**
 * Daily variation factor for a given metric.
 * Returns a deterministic multiplier around 1.0 that varies per day,
 * making bounce rate, avg duration, etc. change across time windows.
 */
export function dailyMetricFactor(
  siteId: string,
  dayNum: number,
  metric: string,
): number {
  const rng = mulberry32(fnv1a(`${siteId}:dfactor:${metric}:${dayNum}`));
  switch (metric) {
    case "sessions":
      return 0.88 + rng() * 0.24;
    case "visitors":
      return 0.9 + rng() * 0.2;
    case "bounce":
      return 0.78 + rng() * 0.44;
    case "duration":
      return 0.65 + rng() * 0.7;
    default:
      return 1.0;
  }
}

/** Compute all six overview metrics via day-by-day integration with daily factors */
export function computeMetrics(siteId: string, fromMs: number, toMs: number) {
  if (fromMs >= toMs) {
    return {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
    };
  }
  const HOUR_MS = 3600000;
  const DAY_H = 24;
  const hp = findSiteProfile(siteId).hourProfile;
  const dayInt = siteDayIntegral(siteId);
  const base = siteRatios(siteId);

  const fromH = fromMs / HOUR_MS;
  const toH = toMs / HOUR_MS;
  const fromDay = Math.floor(fromH / DAY_H);
  const toDay = Math.floor((toH - 1e-9) / DAY_H);

  let sumViews = 0;
  let sumSessions = 0;
  let sumVisitors = 0;
  let sumBounces = 0;
  let sumDurationMs = 0;

  for (let d = fromDay; d <= toDay; d++) {
    const dayStartH = d * DAY_H;
    const h1 = Math.max(fromH - dayStartH, 0);
    const h2 = Math.min(toH - dayStartH, DAY_H);
    if (h1 >= h2) continue;

    const viewsFrac =
      (dailyViewCount(siteId, d) *
        siteHourShapeIntegral(
          h1,
          h2,
          hp.riseHour,
          hp.activeWidth,
          hp.baseLevel,
        )) /
      dayInt;

    const sf = dailyMetricFactor(siteId, d, "sessions");
    const vf = dailyMetricFactor(siteId, d, "visitors");
    const bf = dailyMetricFactor(siteId, d, "bounce");
    const df = dailyMetricFactor(siteId, d, "duration");

    const sessionsFrac = viewsFrac * base.sessionsPerView * sf;
    const visitorsFrac = sessionsFrac * base.visitorsPerSession * vf;
    const bouncesFrac = sessionsFrac * Math.min(1, base.bounceRate * bf);
    const durationFrac = sessionsFrac * base.avgDurationMs * df;

    sumViews += viewsFrac;
    sumSessions += sessionsFrac;
    sumVisitors += visitorsFrac;
    sumBounces += bouncesFrac;
    sumDurationMs += durationFrac;
  }

  const views = Math.round(sumViews);
  const sessions = Math.max(views > 0 ? 1 : 0, Math.round(sumSessions));
  const visitors = Math.max(sessions > 0 ? 1 : 0, Math.round(sumVisitors));
  const bounces = Math.min(sessions, Math.round(sumBounces));
  const totalDurationMs = Math.round(sumDurationMs);
  const bounceRate =
    sessions > 0 ? Math.round((bounces / sessions) * 10000) / 10000 : 0;
  const avgDurationMs =
    sessions > 0 ? Math.round(totalDurationMs / sessions) : 0;

  return {
    views,
    sessions,
    visitors,
    bounces,
    totalDurationMs,
    avgDurationMs,
    bounceRate,
    approximateVisitors: false,
  };
}

export function demoIntervalStepMs(interval: string): number {
  switch (interval) {
    case "minute":
      return 60_000;
    case "hour":
      return 3_600_000;
    case "week":
      return 7 * 86_400_000;
    case "month":
      return 30 * 86_400_000;
    default:
      return 86_400_000;
  }
}

export interface TimestampCurveDistribution {
  from: number;
  to: number;
  bucketMs: number;
  cumulative: number[];
  totalWeight: number;
}

/**
 * Build the bucketed inverse-CDF used for timestamp sampling once per window.
 * The resulting distribution is independent of the caller's RNG, so it can
 * be reused for every session in a dataset.
 */
export function buildTimestampCurveDistribution(
  siteId: string,
  from: number,
  to: number,
): TimestampCurveDistribution | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return null;
  }

  const span = to - from;
  if (span <= 0) return null;

  const HOUR_MS = 3600000;
  const DAY_H = 24;
  const hp = findSiteProfile(siteId).hourProfile;
  const dayInt = siteDayIntegral(siteId);

  // Aim for ~10-min buckets, but cap so we never explode for huge windows.
  const desiredBuckets = Math.min(
    256,
    Math.max(8, Math.ceil(span / (10 * 60_000))),
  );
  const bucketMs = span / desiredBuckets;

  // Precompute one daily prefix sum. Without this, a long window would walk
  // every day once per bucket (256 × ~20,000 days for an epoch-to-now
  // request), which is enough to hit a Worker CPU limit before sampling even
  // starts. A day contributes its full daily view count because the hourly
  // curve is normalized by `dayInt`.
  const fromH = from / HOUR_MS;
  const toH = to / HOUR_MS;
  const firstDay = Math.floor(fromH / DAY_H);
  const lastDay = Math.floor((toH - 1e-9) / DAY_H);
  const dayCount = Math.max(0, lastDay - firstDay + 1);
  const dailyPrefix = new Float64Array(dayCount + 1);
  for (let offset = 0; offset < dayCount; offset += 1) {
    const dayWeight = Math.max(0, dailyViewCount(siteId, firstDay + offset));
    dailyPrefix[offset + 1] = dailyPrefix[offset] + dayWeight;
  }

  const daySectionWeight = (day: number, h1: number, h2: number) => {
    if (h1 >= h2) return 0;
    const index = day - firstDay;
    const dayWeight =
      index >= 0 && index < dayCount
        ? dailyPrefix[index + 1] - dailyPrefix[index]
        : 0;
    return (
      (dayWeight *
        siteHourShapeIntegral(
          h1,
          h2,
          hp.riseHour,
          hp.activeWidth,
          hp.baseLevel,
        )) /
      dayInt
    );
  };

  const fullDayRangeWeight = (startDay: number, endDay: number) => {
    if (startDay > endDay) return 0;
    const startIndex = startDay - firstDay;
    const endIndex = endDay - firstDay;
    return dailyPrefix[endIndex + 1] - dailyPrefix[startIndex];
  };

  let totalWeight = 0;
  const cumulative: number[] = new Array(desiredBuckets);
  for (let i = 0; i < desiredBuckets; i += 1) {
    const segFrom = from + i * bucketMs;
    const segTo = segFrom + bucketMs;
    const segFromH = segFrom / HOUR_MS;
    const segToH = segTo / HOUR_MS;
    const segFromDay = Math.floor(segFromH / DAY_H);
    const segToDay = Math.floor((segToH - 1e-9) / DAY_H);
    let weight = 0;
    if (segFromDay === segToDay) {
      const dayStartH = segFromDay * DAY_H;
      weight = daySectionWeight(
        segFromDay,
        Math.max(segFromH - dayStartH, 0),
        Math.min(segToH - dayStartH, DAY_H),
      );
    } else {
      const firstDayStartH = segFromDay * DAY_H;
      weight += daySectionWeight(
        segFromDay,
        Math.max(segFromH - firstDayStartH, 0),
        DAY_H,
      );
      weight += fullDayRangeWeight(segFromDay + 1, segToDay - 1);
      const lastDayStartH = segToDay * DAY_H;
      weight += daySectionWeight(
        segToDay,
        0,
        Math.min(segToH - lastDayStartH, DAY_H),
      );
    }
    totalWeight += Math.max(0, weight);
    cumulative[i] = totalWeight;
  }

  return { from, to, bucketMs, cumulative, totalWeight };
}

function sampleTimestampFromDistribution(
  distribution: TimestampCurveDistribution,
  rng: () => number,
): number {
  const { from, to, bucketMs, cumulative, totalWeight } = distribution;
  const span = to - from;

  if (totalWeight <= 0) {
    return clampTimestampToWindow(from + Math.floor(rng() * span), from, to);
  }

  const hit = rng() * totalWeight;
  // Find the first cumulative weight at or above the hit in O(log N).
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (hit <= (cumulative[middle] ?? 0)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const bucketStart = from + low * bucketMs;
  return clampTimestampToWindow(bucketStart + rng() * bucketMs, from, to);
}

function clampTimestampToWindow(value: number, from: number, to: number) {
  if (value <= from) return from;
  if (value >= to) {
    if (Number.isInteger(from) && Number.isInteger(to)) {
      return Math.max(from, to - 1);
    }
    return Math.max(
      from,
      to - Math.max(Number.EPSILON, Math.abs(to) * Number.EPSILON),
    );
  }
  return value;
}

/** Create a reusable timestamp sampler for a single site/window pair. */
export function createTimestampCurveSampler(
  siteId: string,
  from: number,
  to: number,
): (rng: () => number) => number {
  const distribution = buildTimestampCurveDistribution(siteId, from, to);
  return (rng: () => number) => {
    if (!distribution) return from;
    return sampleTimestampFromDistribution(distribution, rng);
  };
}

/**
 * Sample a timestamp in [from, to) following the site's day/hour traffic
 * curve. Uses inverse-CDF sampling over N buckets — each bucket's weight is
 * `dailyViewCount(d) × siteHourShapeIntegral(h1, h2, …) / siteDayIntegral`.
 *
 * Replaces the previous uniform sampler `from + rng()*span` so a marketing
 * page (rise 12, width 9) lands its visits in the afternoon, while an OSS
 * project (rise 20, width 16) clusters them around midnight.
 */
export function sampleTimestampByCurve(
  siteId: string,
  from: number,
  to: number,
  rng: () => number,
): number {
  const distribution = buildTimestampCurveDistribution(siteId, from, to);
  if (!distribution) return from;
  return sampleTimestampFromDistribution(distribution, rng);
}
