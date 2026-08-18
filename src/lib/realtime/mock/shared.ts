import { browserEngineLabel } from "@/lib/browser-engine";
import {
  addZonedInterval,
  normalizeTimeZone,
  resolveReportingTimeZone,
  startOfZonedInterval,
  zonedParts,
} from "@/lib/dashboard/time-zone";
import {
  DEMO_SITE_PROFILES,
  type DemoSiteProfile,
  findSiteProfile,
} from "@/lib/realtime/demo-site-profiles";
import {
  createDemoRng,
  expandPathLabels,
  fnv1a,
  mulberry32,
  normalizePath,
  sFloat,
  sInt,
  sPick,
  sShuffle,
  titleFromPath,
  todayKey,
  uniqueNonEmptyStrings,
  weightedDistribution,
  weightedDistributionFromWeights,
  weightedPickLabel,
  windowBucket,
} from "@/lib/realtime/demo-utils";
import {
  generateDemoDoDiagnostic,
  generateDemoSystemPerformance,
  getDemoMembers,
  getDemoScriptSnippet,
  getDemoSiteConfig,
  getDemoSites,
  getDemoTeams,
  getDemoUser,
} from "@/lib/realtime/mock/admin";
import {
  buildCountryPool,
  buildReferrerPool,
  DEMO_CITIES_BY_COUNTRY,
  DEMO_REGIONS_BY_COUNTRY,
  filterGeoLabelsByCountries,
  groupGeoLabelsByCountry,
  isMobileBrowserLabel,
  normalizeLongitude,
  parseDemoCityLabel,
  parseDemoRegionLabel,
  pickCountryGeoCluster,
  pickDemoBrowser,
  pickDemoBrowserVersion,
  pickDemoContinent,
  pickDemoDeviceType,
  pickDemoGeoContext,
  pickDemoLanguage,
  pickDemoOrganization,
  pickDemoOsVersion,
  pickDemoScreenSize,
  pickDemoTimezone,
  pickFromList,
  pickReferrerByCountry,
  randomGaussian,
  sampleGeoPointByCountry,
  weightedPickCountry,
  weightedPickIndex,
} from "@/lib/realtime/mock/dimension-pickers";
import {
  ALL_BROWSERS,
  ALL_CITIES,
  ALL_CONTINENTS,
  ALL_LANGUAGES,
  ALL_ORGS,
  ALL_OS,
  ALL_REGIONS,
  ALL_SCREEN_SIZES,
  ALL_TIMEZONES,
  BROWSER_MARKET_WEIGHTS,
  COUNTRY_COORDINATE_ANCHORS,
  COUNTRY_GEO_CLUSTERS,
  DEMO_COUNTRY_TO_CONTINENT,
  DEMO_COUNTRY_TO_LANGUAGES,
  DEMO_COUNTRY_TO_TIMEZONES,
  DEMO_DESKTOP_OS,
  DEMO_DESKTOP_SCREENS,
  DEMO_GEO_SEGMENT_SEPARATOR,
  DEMO_MOBILE_OS,
  DEMO_MOBILE_SCREENS,
  DEMO_TABLET_SCREENS,
  type GeoCluster,
  GLOBAL_COUNTRY_LONG_TAIL,
  GLOBAL_REFERRER_LONG_TAIL,
} from "@/lib/realtime/mock/dimension-pools";
import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  aggregateSessionEdgeRows,
  applyDemoFilters,
  buildDemoFactDataset,
  buildDemoPathTitleMap,
  collectClientTabs,
  collectGeoTabs,
  collectPageDataAndTabs,
  collectReferrerRows,
  DEMO_FACT_DATASET_CACHE,
  emptyDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/realtime/mock/fact-builder";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  DEMO_INTERVALS,
  demoValuesIncludeSearch,
  normalizeDemoFilterValue,
  normalizeDemoSearch,
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoGeoFilterValue,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
  withoutDemoGeoFilter,
} from "@/lib/realtime/mock/filters";
import {
  buildPathTransitionGraph,
  nextPath,
} from "@/lib/realtime/mock/path-markov";
import {
  computeMetrics,
  dailyMetricFactor,
  dailyViewCount,
  demoIntervalStepMs,
  integrateViews,
  sampleTimestampByCurve,
  siteDayIntegral,
  siteHourShapeIntegral,
  type SiteMetricRatios,
  siteRatios,
} from "@/lib/realtime/mock/site-curves";
import type {
  DemoDimensionRow,
  DemoFactDataset,
  DemoFilteredFacts,
  DemoQueryFilters,
  DemoSessionFact,
  DemoVisitFact,
  DemoVisitorFact,
  ParsedDemoGeoFilter,
} from "@/lib/realtime/mock/types";
import {
  DEMO_EMPTY_HASH_VALUE,
  DEMO_EMPTY_QUERY_VALUE,
  demoHashFragmentForVisit,
  demoOperatingSystemLabel,
  demoQueryStringForVisit,
  demoStringHash,
} from "@/lib/realtime/mock/visit-helpers";
import {
  getVisitorFingerprint,
  sampleActiveVisitors,
} from "@/lib/realtime/mock/visitor-pool";

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
  const bucket = buckets.find(
    (item) => timestampMs >= item.fromMs && timestampMs < item.toMs,
  );
  return bucket?.index ?? null;
}

export function buildDemoTrendBuckets(
  siteId: string,
  from: number,
  to: number,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: DemoQueryFilters,
  timeZone: string,
) {
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const dataset = buildDemoFactDataset(siteId, from, to);
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

type DemoEventRecordSortKey = "occurredAt" | "eventName" | "pathname";

interface DemoCustomEventFact {
  eventId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  visit: DemoVisitFact;
}

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
