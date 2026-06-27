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
import { generateDemoPages } from "@/lib/realtime/mock/analytics";
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
  DemoEventPayloadFilterRule,
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
export {
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/realtime/mock/utm-dimensions";

function generateDemoClientDimensionTabs(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 100, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const tabs = collectClientTabs(dataset, filtered, limit);

  return {
    ok: true,
    tabs,
  };
}

function generateDemoGeoDimensionTabs(
  siteId: string,
  params: Record<string, string | number>,
  options?: {
    ignoreGeo?: boolean;
  },
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 100, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const rawFilters = parseDemoFilters(params);
  const filters = options?.ignoreGeo
    ? withoutDemoGeoFilter(rawFilters)
    : rawFilters;
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const tabs = collectGeoTabs(dataset, filtered, limit);

  return {
    ok: true,
    tabs,
  };
}

export function generateDemoGeoPoints(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 5000, 50, 20_000);
  const from = parseDemoNumber(
    params.from,
    Math.max(0, Date.now() - 24 * 3600 * 1000),
  );
  const to = parseDemoNumber(params.to, Date.now());
  const rawFilters = parseDemoFilters(params);
  const filters = parseDemoBoolean(params.applyGeoFilter)
    ? rawFilters
    : withoutDemoGeoFilter(rawFilters);
  const parsedGeo = parseDemoGeoFilterValue(filters.geo);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const orderedVisits = [...filtered.visits].sort(
    (left, right) => right.startedAt - left.startedAt,
  );

  const countryBuckets = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const visit of filtered.visits) {
    const bucket = countryBuckets.get(visit.country) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += dataset.viewWeight;
    bucket.sessions.add(visit.sessionId);
    bucket.visitors.add(visit.visitorId);
    countryBuckets.set(visit.country, bucket);
  }

  const countryCounts = Array.from(countryBuckets.entries())
    .map(([country, bucket]) => ({
      country,
      views: Math.max(0, Math.round(bucket.views)),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views || left.country.localeCompare(right.country),
    );

  const regionBuckets = new Map<
    string,
    {
      label: string;
      views: number;
      sessions: Set<string>;
      visitors: Set<string>;
    }
  >();
  const cityBuckets = new Map<
    string,
    {
      label: string;
      views: number;
      sessions: Set<string>;
      visitors: Set<string>;
    }
  >();

  for (const visit of filtered.visits) {
    if (visit.region) {
      const regionBucket = regionBuckets.get(visit.region) ?? {
        label: parseDemoRegionLabel(visit.region)?.regionName || visit.region,
        views: 0,
        sessions: new Set<string>(),
        visitors: new Set<string>(),
      };
      regionBucket.views += dataset.viewWeight;
      regionBucket.sessions.add(visit.sessionId);
      regionBucket.visitors.add(visit.visitorId);
      regionBuckets.set(visit.region, regionBucket);
    }

    if (visit.city) {
      const cityBucket = cityBuckets.get(visit.city) ?? {
        label: parseDemoCityLabel(visit.city)?.cityName || visit.city,
        views: 0,
        sessions: new Set<string>(),
        visitors: new Set<string>(),
      };
      cityBucket.views += dataset.viewWeight;
      cityBucket.sessions.add(visit.sessionId);
      cityBucket.visitors.add(visit.visitorId);
      cityBuckets.set(visit.city, cityBucket);
    }
  }

  const regionCounts =
    parsedGeo?.country && !parsedGeo.regionCode && !parsedGeo.regionName
      ? Array.from(regionBuckets.entries())
          .map(([value, bucket]) => ({
            value,
            label: bucket.label,
            views: Math.max(0, Math.round(bucket.views)),
            sessions: Math.max(
              0,
              Math.round(weightedSessionCount(dataset, bucket.sessions)),
            ),
            visitors: Math.max(
              0,
              Math.round(weightedVisitorCount(dataset, bucket.visitors)),
            ),
          }))
          .sort(
            (left, right) =>
              right.views - left.views || left.label.localeCompare(right.label),
          )
      : [];

  const cityCounts =
    parsedGeo?.country && (parsedGeo.regionCode || parsedGeo.regionName)
      ? Array.from(cityBuckets.entries())
          .map(([value, bucket]) => ({
            value,
            label: bucket.label,
            views: Math.max(0, Math.round(bucket.views)),
            sessions: Math.max(
              0,
              Math.round(weightedSessionCount(dataset, bucket.sessions)),
            ),
            visitors: Math.max(
              0,
              Math.round(weightedVisitorCount(dataset, bucket.visitors)),
            ),
          }))
          .sort(
            (left, right) =>
              right.views - left.views || left.label.localeCompare(right.label),
          )
      : [];

  // Aggregate points by rounded coordinates (3 decimal places, ~110m precision)
  const aggregatedPoints = new Map<
    string,
    {
      latitude: number;
      longitude: number;
      timestampMs: number;
      country: string;
      region: string;
      regionCode: string;
      city: string;
      pointCount: number;
    }
  >();

  for (const visit of orderedVisits) {
    const latBucket = Math.round(visit.latitude * 1000) / 1000;
    const lonBucket = Math.round(visit.longitude * 1000) / 1000;
    const key = `${latBucket}:${lonBucket}:${visit.country}:${visit.region}:${visit.regionCode}:${visit.city}`;

    const existing = aggregatedPoints.get(key);
    if (existing) {
      existing.pointCount += 1;
      existing.timestampMs = Math.max(existing.timestampMs, visit.startedAt);
    } else {
      aggregatedPoints.set(key, {
        latitude: latBucket,
        longitude: lonBucket,
        timestampMs: visit.startedAt,
        country: visit.country,
        region: visit.region,
        regionCode: visit.regionCode,
        city: visit.city,
        pointCount: 1,
      });
    }
  }

  const sortedAggregated = [...aggregatedPoints.values()].sort(
    (left, right) => right.timestampMs - left.timestampMs,
  );

  return {
    ok: true,
    data: sortedAggregated.slice(0, limit),
    countryCounts,
    regionCounts,
    cityCounts,
  };
}

export function generateDemoOverviewPageTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "path" | "title" | "hostname" | "entry" | "exit",
): Record<string, unknown> {
  const payload = generateDemoPages(siteId, params) as {
    ok: boolean;
    tabs?: Record<string, unknown>;
  };
  const data = Array.isArray(payload.tabs?.[tab]) ? payload.tabs?.[tab] : [];
  return {
    ok: payload.ok,
    data,
  };
}

export function generateDemoOverviewSourceTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "domain" | "link",
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 100, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const rows = collectReferrerRows(dataset, filtered, limit, {
    includeFullUrl: tab === "link",
    directValue: "",
  });
  return {
    ok: true,
    data: rows.map((item) => ({
      label: String(item.referrer ?? ""),
      views: Number(item.views ?? 0),
      sessions: Number(item.sessions ?? 0),
      visitors: Number(item.visitors ?? 0),
    })),
  };
}

export function generateDemoOverviewClientTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "browser" | "osVersion" | "deviceType" | "language" | "screenSize",
): Record<string, unknown> {
  const payload = generateDemoClientDimensionTabs(siteId, params) as {
    ok: boolean;
    tabs?: Record<string, unknown>;
  };
  const data = Array.isArray(payload.tabs?.[tab]) ? payload.tabs?.[tab] : [];
  return {
    ok: payload.ok,
    data,
  };
}

export function generateDemoOverviewGeoTab(
  siteId: string,
  params: Record<string, string | number>,
  tab:
    | "country"
    | "region"
    | "city"
    | "continent"
    | "timezone"
    | "organization",
): Record<string, unknown> {
  const payload = generateDemoGeoDimensionTabs(siteId, params, {
    ignoreGeo: tab === "country",
  }) as {
    ok: boolean;
    tabs?: Record<string, unknown>;
  };
  const data = Array.isArray(payload.tabs?.[tab]) ? payload.tabs?.[tab] : [];
  return {
    ok: payload.ok,
    data,
  };
}

export { generateDemoFilterOptions } from "@/lib/realtime/mock/filter-options";
