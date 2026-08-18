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
  buildDemoTimeBuckets,
  buildDemoTrendBuckets,
  createDemoShareTrendSeriesKey,
  DEMO_BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  DEMO_BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  DEMO_BROWSER_CROSS_UNKNOWN_TOKEN,
  DEMO_BROWSER_VERSION_UNKNOWN_TOKEN,
  DEMO_CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  DEMO_CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  DEMO_CLIENT_CROSS_UNKNOWN_TOKEN,
  DEMO_SHARE_TREND_OTHER_KEY,
  DEMO_SHARE_TREND_OTHER_LABEL,
  type DemoClientDimensionKey,
  demoClientDimensionMeta,
  type DemoSortDirection,
  type DemoTimeBucket,
  findDemoTimeBucketIndex,
  parseDemoClientDimensionKey,
  parseDemoScreenSize,
  parseDemoTimeZone,
} from "@/lib/realtime/mock/shared";
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
function generateDemoShareTrend(
  siteId: string,
  params: Record<string, string | number>,
  options: {
    fallbackKeyBase: string;
    getLabel: (visit: DemoVisitFact) => string;
  },
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const limit = parseDemoLimit(params.limit, 5, 1, 12);
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
      const sessionSet =
        point.sessionSets.get(seriesItem.key) ?? new Set<string>();
      const sessions = Math.max(
        0,
        Math.round(weightedSessionCount(dataset, sessionSet)),
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
  });
}

export function generateDemoReferrerTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const interval = parseDemoInterval(params.interval);
  return generateDemoShareTrend(siteId, params, {
    fallbackKeyBase: "referrer-domain",
    getLabel: (visit) =>
      visit.referrerHost.trim() || DEMO_DIRECT_REFERRER_FILTER_VALUE,
  });
}
