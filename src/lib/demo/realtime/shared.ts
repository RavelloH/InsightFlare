import {
  addZonedInterval,
  resolveReportingTimeZone,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import {
  applyDemoFilters,
  buildDemoFactDataset,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import { demoValuesIncludeSearch } from "@/lib/demo/realtime/filters";
import { demoIntervalStepMs } from "@/lib/demo/realtime/site-curves";
import type {
  DemoFactDataset,
  DemoQueryFilters,
  DemoVisitFact,
} from "@/lib/demo/realtime/types";
import {
  demoHashFragmentForVisit,
  demoOperatingSystemLabel,
  demoQueryStringForVisit,
} from "@/lib/demo/realtime/visit-helpers";
export function demoVisitMatchesJourneySearch(
  dataset: DemoFactDataset,
  visit: DemoVisitFact,
  search: string,
): boolean {
  if (!search) return true;
  const session = dataset.sessions.get(visit.sessionId);
  return demoValuesIncludeSearch(search, [
    visit.visitorId,
    visit.sessionId,
    visit.userId,
    visit.userName,
    visit.pathname,
    demoQueryStringForVisit(visit),
    demoHashFragmentForVisit(visit),
    visit.hostname,
    visit.title,
    visit.referrerHost || "direct",
    visit.referrerUrl || "direct",
    visit.country,
    visit.regionName,
    visit.regionCode,
    visit.region,
    visit.cityName,
    visit.city,
    visit.browser,
    visit.browserVersion,
    `${visit.browser} ${visit.browserVersion}`,
    demoOperatingSystemLabel(visit.osVersion),
    visit.osVersion,
    visit.deviceType,
    session?.entryPath,
    session?.exitPath,
  ]);
}
export interface DemoTimeBucket {
  index: number;
  timestampMs: number;
  fromMs: number;
  toMs: number;
}
export function parseDemoTimeZone(
  params: Record<string, string | number>,
): string {
  return resolveReportingTimeZone(
    String(params.timeZone || params.tz || "").trim(),
  );
}
export function buildDemoTimeBuckets(
  from: number,
  to: number,
  interval: "minute" | "hour" | "day" | "week" | "month",
  timeZone: string,
): DemoTimeBucket[] {
  const safeFrom = Number.isFinite(from) ? from : 0;
  const safeTo = Number.isFinite(to) ? to : safeFrom;
  const buckets: DemoTimeBucket[] = [];
  let current = startOfZonedInterval(safeFrom, interval, timeZone);
  const hardLimit = 2000;

  for (let index = 0; index < hardLimit && current <= safeTo; index += 1) {
    let next = addZonedInterval(current, interval, timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + demoIntervalStepMs(interval);
    }
    buckets.push({
      index,
      timestampMs: current,
      fromMs: current,
      toMs: next,
    });
    current = next;
  }

  if (buckets.length === 0) {
    const fallbackStart = Math.max(0, Math.floor(safeFrom));
    buckets.push({
      index: 0,
      timestampMs: fallbackStart,
      fromMs: fallbackStart,
      toMs: Math.max(fallbackStart + 1, Math.floor(safeTo) + 1),
    });
  }

  return buckets;
}
export function findDemoTimeBucketIndex(
  buckets: DemoTimeBucket[],
  timestampMs: number,
): number | null {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const bucket = buckets[middle];
    if (!bucket) break;
    if (timestampMs < bucket.fromMs) {
      high = middle - 1;
    } else if (timestampMs >= bucket.toMs) {
      low = middle + 1;
    } else {
      return bucket.index;
    }
  }
  return null;
}
export function buildDemoTrendBuckets(
  siteId: string,
  from: number,
  to: number,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: DemoQueryFilters,
  timeZone: string,
  datasetOverride?: DemoFactDataset,
) {
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const dataset = datasetOverride ?? buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const bucketStats = new Map<
    number,
    {
      views: number;
      totalDurationMs: number;
      visitors: Set<string>;
      sessions: number;
      bounces: number;
    }
  >();
  const sessionFirstTs = new Map<string, number>();

  const ensureBucket = (bucket: number) => {
    const existing = bucketStats.get(bucket);
    if (existing) return existing;
    const created = {
      views: 0,
      totalDurationMs: 0,
      visitors: new Set<string>(),
      sessions: 0,
      bounces: 0,
    };
    bucketStats.set(bucket, created);
    return created;
  };

  for (const visit of filtered.visits) {
    const bucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (bucket === null) continue;
    const agg = ensureBucket(bucket);
    agg.views += dataset.viewWeight;
    agg.totalDurationMs += visit.durationMs * dataset.viewWeight;
    agg.visitors.add(visit.visitorId);
    const firstTs = sessionFirstTs.get(visit.sessionId);
    if (firstTs === undefined || visit.startedAt < firstTs) {
      sessionFirstTs.set(visit.sessionId, visit.startedAt);
    }
  }

  for (const [sessionId, sessionStartedAt] of sessionFirstTs.entries()) {
    const bucket = findDemoTimeBucketIndex(buckets, sessionStartedAt);
    if (bucket === null) continue;
    const agg = ensureBucket(bucket);
    const sessionWeight = dataset.sessions.get(sessionId)?.weight ?? 0;
    agg.sessions += sessionWeight;
    if ((filtered.visitsBySession.get(sessionId) ?? 0) === 1) {
      agg.bounces += sessionWeight;
    }
  }

  const rows: Array<{
    bucket: number;
    timestampMs: number;
    views: number;
    visitors: number;
    sessions: number;
    bounces: number;
    totalDurationMs: number;
    avgDurationMs: number;
    source: string;
  }> = [];
  for (const timeBucket of buckets) {
    const bucket = timeBucket.index;
    const agg = bucketStats.get(bucket);
    const views = Math.max(0, Math.round(agg?.views ?? 0));
    const visitors = Math.max(
      0,
      Math.round(agg ? weightedVisitorCount(dataset, agg.visitors) : 0),
    );
    const sessions = Math.max(0, Math.round(agg?.sessions ?? 0));
    const bounces = Math.min(
      sessions,
      Math.max(0, Math.round(agg?.bounces ?? 0)),
    );
    const totalDurationMs = Math.max(0, Math.round(agg?.totalDurationMs ?? 0));
    rows.push({
      bucket,
      timestampMs: timeBucket.timestampMs,
      views,
      visitors,
      sessions,
      bounces,
      totalDurationMs,
      avgDurationMs: sessions > 0 ? Math.round(totalDurationMs / sessions) : 0,
      source: "detail",
    });
  }
  return rows;
}
export const DEMO_SHARE_TREND_OTHER_KEY = "other";
export const DEMO_SHARE_TREND_OTHER_LABEL = "Other";
export const DEMO_BROWSER_VERSION_UNKNOWN_TOKEN = "__browser_version_unknown__";
export const DEMO_BROWSER_CROSS_UNKNOWN_TOKEN = "__browser_cross_unknown__";
export const DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN =
  "__browser_cross_other_browser__";
export const DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN =
  "__browser_cross_other_dimension__";
export const DEMO_CLIENT_CROSS_UNKNOWN_TOKEN = "__client_cross_unknown__";
export const DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN =
  "__client_cross_other_primary__";
export const DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN =
  "__client_cross_other_secondary__";
export type DemoClientDimensionKey =
  | "browser"
  | "operatingSystem"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";
export function createDemoShareTrendSeriesKey(
  label: string,
  usedKeys: Set<string>,
  fallbackBase: string,
): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized || fallbackBase;
  let candidate = base;
  let suffix = 2;

  while (usedKeys.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedKeys.add(candidate);
  return candidate;
}
export function parseDemoClientDimensionKey(
  value: string | number | undefined,
): DemoClientDimensionKey | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "browser" ||
    normalized === "operatingSystem" ||
    normalized === "osVersion" ||
    normalized === "deviceType" ||
    normalized === "language" ||
    normalized === "screenSize"
  ) {
    return normalized as DemoClientDimensionKey;
  }
  return null;
}
export function demoClientDimensionMeta(dimension: DemoClientDimensionKey): {
  fallbackKeyBase: string;
  getLabel: (visit: DemoVisitFact) => string;
} {
  if (dimension === "browser") {
    return {
      fallbackKeyBase: "browser",
      getLabel: (visit) => visit.browser,
    };
  }
  if (dimension === "operatingSystem") {
    return {
      fallbackKeyBase: "os",
      getLabel: (visit) => demoOperatingSystemLabel(visit.osVersion),
    };
  }
  if (dimension === "osVersion") {
    return {
      fallbackKeyBase: "os-version",
      getLabel: (visit) => visit.osVersion,
    };
  }
  if (dimension === "deviceType") {
    return {
      fallbackKeyBase: "device",
      getLabel: (visit) => visit.deviceType,
    };
  }
  if (dimension === "language") {
    return {
      fallbackKeyBase: "language",
      getLabel: (visit) => visit.language,
    };
  }
  return {
    fallbackKeyBase: "screen",
    getLabel: (visit) => visit.screenSize,
  };
}
export function parseDemoScreenSize(value: string): {
  screenWidth: number | null;
  screenHeight: number | null;
} {
  const match = String(value || "").match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return { screenWidth: null, screenHeight: null };
  return {
    screenWidth: Number(match[1]) || null,
    screenHeight: Number(match[2]) || null,
  };
}
export type DemoSortDirection = "asc" | "desc";
