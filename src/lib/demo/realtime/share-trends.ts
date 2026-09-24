import { classifyTrafficChannel } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineLabel } from "@/lib/browser-engine";
import {
  applyDemoFilters,
  buildDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  parseDemoFilters,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import {
  buildDemoTimeBuckets,
  createDemoShareTrendSeriesKey,
  DEMO_SHARE_TREND_OTHER_KEY,
  DEMO_SHARE_TREND_OTHER_LABEL,
  demoClientDimensionMeta,
  type DemoTimeBucket,
  findDemoTimeBucketIndex,
  parseDemoClientDimensionKey,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import type { DemoVisitFact } from "@/lib/demo/realtime/types";
function generateDemoShareTrend(
  siteId: string,
  params: Record<string, string | number>,
  options: {
    fallbackKeyBase: string;
    getLabel: (visit: DemoVisitFact) => string;
    maxLimit?: number;
  },
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const limit = parseDemoLimit(params.limit, 5, 1, options.maxLimit ?? 12);
  const filters = parseDemoFilters(params);
  const timeZone = parseDemoTimeZone(params);
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const labelForVisit = (visit: DemoVisitFact) =>
    String(options.getLabel(visit) ?? "").trim();
  const visitorLabels = new Map<string, string>();
  const bucketVisitorLabels = new Map<number, Map<string, string>>();

  for (const visit of filtered.visits) {
    const label = labelForVisit(visit);
    visitorLabels.set(visit.visitorId, label);

    const bucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (bucket === null) continue;
    const labelsForBucket =
      bucketVisitorLabels.get(bucket) ?? new Map<string, string>();
    labelsForBucket.set(visit.visitorId, label);
    bucketVisitorLabels.set(bucket, labelsForBucket);
  }

  const overallBuckets = new Map<
    string,
    { views: number; visitors: Set<string>; sessions: Set<string> }
  >();
  for (const visit of filtered.visits) {
    const label = visitorLabels.get(visit.visitorId) ?? "";
    if (!label) continue;

    const bucket = overallBuckets.get(label) ?? {
      views: 0,
      visitors: new Set<string>(),
      sessions: new Set<string>(),
    };
    bucket.views += dataset.viewWeight;
    bucket.visitors.add(visit.visitorId);
    bucket.sessions.add(visit.sessionId);
    overallBuckets.set(label, bucket);
  }

  const topRows = Array.from(overallBuckets.entries())
    .map(([label, bucket]) => ({
      label,
      views: Math.max(0, Math.round(bucket.views)),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
    }))
    .sort(
      (left, right) =>
        right.visitors - left.visitors ||
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
  const topLabels = topRows.map((row) => row.label);
  const topLabelSet = new Set(topLabels);
  const usedKeys = new Set<string>([DEMO_SHARE_TREND_OTHER_KEY]);
  const keyByLabel = new Map<string, string>();
  const series: Array<{
    key: string;
    label: string;
    views: number;
    visitors: number;
    sessions: number;
    isOther?: boolean;
  }> = topRows.map((row) => {
    const key = createDemoShareTrendSeriesKey(
      row.label,
      usedKeys,
      options.fallbackKeyBase,
    );
    keyByLabel.set(row.label, key);
    return {
      key,
      label: row.label,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    };
  });

  const otherSessions = new Set<string>();
  const otherVisitors = new Set<string>();
  let otherViews = 0;
  for (const visit of filtered.visits) {
    const label = visitorLabels.get(visit.visitorId) ?? "";
    if (label && topLabelSet.has(label)) continue;
    otherViews += dataset.viewWeight;
    otherSessions.add(visit.sessionId);
    otherVisitors.add(visit.visitorId);
  }

  let hasBucketOther = false;
  for (const labelsForBucket of bucketVisitorLabels.values()) {
    for (const label of labelsForBucket.values()) {
      if (!label || !topLabelSet.has(label)) {
        hasBucketOther = true;
        break;
      }
    }
    if (hasBucketOther) break;
  }

  if (otherVisitors.size > 0 || hasBucketOther) {
    keyByLabel.set(DEMO_SHARE_TREND_OTHER_LABEL, DEMO_SHARE_TREND_OTHER_KEY);
    series.push({
      key: DEMO_SHARE_TREND_OTHER_KEY,
      label: DEMO_SHARE_TREND_OTHER_LABEL,
      views: Math.max(0, Math.round(otherViews)),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, otherVisitors)),
      ),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, otherSessions)),
      ),
      isOther: true,
    });
  }

  if (series.length === 0) {
    return {
      ok: true,
      interval,
      series: [],
      data: [],
    };
  }

  const createEmptyPoint = (bucket: DemoTimeBucket) => ({
    bucket: bucket.index,
    timestampMs: bucket.timestampMs,
    totalVisitors: 0,
    visitorsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
  });

  const bucketMap = new Map<
    number,
    {
      bucket: number;
      timestampMs: number;
      totalVisitors: number;
      visitorsBySeries: Record<string, number>;
      sessionSets: Map<string, Set<string>>;
      visitorSets: Map<string, Set<string>>;
    }
  >();

  for (const visit of filtered.visits) {
    const bucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (bucket === null) continue;
    const bucketLabel =
      bucketVisitorLabels.get(bucket)?.get(visit.visitorId) ?? "";
    const label =
      bucketLabel && topLabelSet.has(bucketLabel)
        ? bucketLabel
        : DEMO_SHARE_TREND_OTHER_LABEL;
    const key = keyByLabel.get(label);
    if (!key) continue;

    const point = bucketMap.get(bucket) ?? {
      ...createEmptyPoint(
        buckets[bucket] ?? {
          index: bucket,
          timestampMs: visit.startedAt,
          fromMs: visit.startedAt,
          toMs: visit.startedAt + 1,
        },
      ),
      sessionSets: new Map<string, Set<string>>(),
      visitorSets: new Map<string, Set<string>>(),
    };

    const sessionSet = point.sessionSets.get(key) ?? new Set<string>();
    sessionSet.add(visit.sessionId);
    point.sessionSets.set(key, sessionSet);

    const visitorSet = point.visitorSets.get(key) ?? new Set<string>();
    visitorSet.add(visit.visitorId);
    point.visitorSets.set(key, visitorSet);
    bucketMap.set(bucket, point);
  }

  for (const point of bucketMap.values()) {
    let totalVisitors = 0;
    for (const seriesItem of series) {
      const visitorSet =
        point.visitorSets.get(seriesItem.key) ?? new Set<string>();
      const visitors = Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, visitorSet)),
      );
      point.visitorsBySeries[seriesItem.key] = visitors;
      totalVisitors += visitors;
    }
    point.totalVisitors = totalVisitors;
  }

  const data = [];
  for (const bucket of buckets) {
    const existing = bucketMap.get(bucket.index);
    if (existing) {
      data.push({
        bucket: existing.bucket,
        timestampMs: existing.timestampMs,
        totalVisitors: existing.totalVisitors,
        visitorsBySeries: existing.visitorsBySeries,
      });
    } else {
      data.push(createEmptyPoint(bucket));
    }
  }

  return {
    ok: true,
    interval,
    series,
    data,
  };
}
export function generateDemoBrowserTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: "browser",
    getLabel: (visit) => visit.browser,
  });
}
export function generateDemoBrowserEngineTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: "engine",
    getLabel: (visit) => browserEngineLabel(visit.browser, visit.osVersion),
    maxLimit: 8,
  });
}
export function generateDemoClientDimensionTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const dimension = parseDemoClientDimensionKey(params.dimension);
  if (!dimension) {
    return {
      ok: true,
      interval: parseDemoInterval(params.interval),
      series: [],
      data: [],
    };
  }

  const meta = demoClientDimensionMeta(dimension);
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: meta.fallbackKeyBase,
    getLabel: meta.getLabel,
    maxLimit: 8,
  });
}
export function generateDemoReferrerTrend(
  siteId: string,
  params: Record<string, string | number>,
  options: { maxLimit?: number } = {},
): Record<string, unknown> {
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: "referrer-domain",
    getLabel: (visit) =>
      visit.referrerHost.trim() || DEMO_DIRECT_REFERRER_FILTER_VALUE,
    maxLimit: options.maxLimit ?? 8,
  });
}
export function generateDemoChannelTrend(
  siteId: string,
  params: Record<string, string | number>,
  options: { maxLimit?: number } = {},
): Record<string, unknown> {
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: "traffic-channel",
    getLabel: (visit) =>
      classifyTrafficChannel({
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
      }),
    maxLimit: options.maxLimit ?? 12,
  });
}
