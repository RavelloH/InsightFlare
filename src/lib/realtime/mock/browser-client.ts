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
export {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserVersionBreakdown,
} from "@/lib/realtime/mock/browser-client-breakdowns";

export function generateDemoBrowserRadar(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  const topBrowsers = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    999,
    (visit) => visit.browser,
    "visitors",
  ).filter((row) => row.label.trim().length > 0 && row.visitors > 0);

  if (topBrowsers.length === 0) {
    return { ok: true, data: [] };
  }

  const totalVisitors = topBrowsers.reduce((sum, b) => sum + b.visitors, 0);
  const globalFrequency =
    filtered.visitors.size > 0
      ? filtered.sessions.size / filtered.visitors.size
      : 1;

  const data = topBrowsers.map((browserRow) => {
    const browserVisits = filtered.visits.filter(
      (v) => v.browser === browserRow.label,
    );

    // session-level aggregation
    const sessionMap = new Map<
      string,
      { visitCount: number; totalDuration: number }
    >();
    for (const v of browserVisits) {
      const entry = sessionMap.get(v.sessionId) ?? {
        visitCount: 0,
        totalDuration: 0,
      };
      entry.visitCount += 1;
      entry.totalDuration += Math.max(0, v.durationMs);
      sessionMap.set(v.sessionId, entry);
    }
    const sessions = sessionMap.size;
    const bounces = Array.from(sessionMap.values()).filter(
      (s) => s.visitCount === 1,
    ).length;
    const totalDuration = Array.from(sessionMap.values()).reduce(
      (sum, s) => sum + s.totalDuration,
      0,
    );
    const totalPages = Array.from(sessionMap.values()).reduce(
      (sum, s) => sum + s.visitCount,
      0,
    );

    // visitor-level aggregation
    const visitorSessionMap = new Map<string, Set<string>>();
    for (const v of browserVisits) {
      const set = visitorSessionMap.get(v.visitorId) ?? new Set<string>();
      set.add(v.sessionId);
      visitorSessionMap.set(v.visitorId, set);
    }
    const visitors = visitorSessionMap.size;
    const returningVisitors = Array.from(visitorSessionMap.values()).filter(
      (s) => s.size > 1,
    ).length;

    const avgDuration = sessions > 0 ? totalDuration / sessions : 0;
    const engagement =
      sessions > 0 ? Number(((sessions - bounces) / sessions).toFixed(6)) : 0;
    const depth = sessions > 0 ? totalPages / sessions : 0;
    const loyalty =
      visitors > 0 ? Number((returningVisitors / visitors).toFixed(6)) : 0;
    // Use site-wide frequency ratio as base with per-browser deterministic
    // variation: demo assigns random browsers per session so per-browser
    // raw frequency is always ~1.  Real data does not have this problem.
    let nameHash = 0;
    for (let i = 0; i < browserRow.label.length; i++) {
      nameHash =
        ((nameHash << 5) - nameHash + browserRow.label.charCodeAt(i)) | 0;
    }
    const variation = 0.75 + (Math.abs(nameHash) % 100) / 200; // 0.75 – 1.25
    const frequency = globalFrequency * variation;
    const traffic =
      totalVisitors > 0
        ? Number((browserRow.visitors / totalVisitors).toFixed(6))
        : 0;

    return {
      browser: browserRow.label,
      visitors: browserRow.visitors,
      sessions: browserRow.sessions,
      metrics: {
        duration: avgDuration,
        engagement,
        depth,
        loyalty,
        frequency,
        traffic,
      },
    };
  });

  return { ok: true, data };
}

export function generateDemoReferrerRadar(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const limit = parseDemoLimit(params.limit, 24, 1, 48);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  const topReferrers = collectReferrerRows(dataset, filtered, 999, {
    includeFullUrl: false,
    directValue: "",
  }).filter((row) => row.visitors > 0);

  if (topReferrers.length === 0) {
    return { ok: true, data: [] };
  }

  const selectedReferrers = topReferrers.slice(0, limit);
  const totalVisitors = topReferrers.reduce(
    (sum, row) => sum + row.visitors,
    0,
  );
  const globalFrequency =
    filtered.visitors.size > 0
      ? filtered.sessions.size / filtered.visitors.size
      : 1;

  const data = selectedReferrers.map((referrerRow) => {
    const referrerVisits = filtered.visits.filter((visit) => {
      const label = visit.referrerHost.trim();
      return label === referrerRow.referrer;
    });

    const sessionMap = new Map<
      string,
      { visitCount: number; totalDuration: number }
    >();
    for (const visit of referrerVisits) {
      const entry = sessionMap.get(visit.sessionId) ?? {
        visitCount: 0,
        totalDuration: 0,
      };
      entry.visitCount += 1;
      entry.totalDuration += Math.max(0, visit.durationMs);
      sessionMap.set(visit.sessionId, entry);
    }
    const sessions = sessionMap.size;
    const bounces = Array.from(sessionMap.values()).filter(
      (session) => session.visitCount === 1,
    ).length;
    const totalDuration = Array.from(sessionMap.values()).reduce(
      (sum, session) => sum + session.totalDuration,
      0,
    );
    const totalPages = Array.from(sessionMap.values()).reduce(
      (sum, session) => sum + session.visitCount,
      0,
    );

    const visitorSessionMap = new Map<string, Set<string>>();
    for (const visit of referrerVisits) {
      const set = visitorSessionMap.get(visit.visitorId) ?? new Set<string>();
      set.add(visit.sessionId);
      visitorSessionMap.set(visit.visitorId, set);
    }
    const visitors = visitorSessionMap.size;
    const returningVisitors = Array.from(visitorSessionMap.values()).filter(
      (set) => set.size > 1,
    ).length;

    const avgDuration = sessions > 0 ? totalDuration / sessions : 0;
    const engagement =
      sessions > 0 ? Number(((sessions - bounces) / sessions).toFixed(6)) : 0;
    const depth = sessions > 0 ? totalPages / sessions : 0;
    const loyalty =
      visitors > 0 ? Number((returningVisitors / visitors).toFixed(6)) : 0;
    let nameHash = 0;
    for (let i = 0; i < referrerRow.referrer.length; i++) {
      nameHash =
        ((nameHash << 5) - nameHash + referrerRow.referrer.charCodeAt(i)) | 0;
    }
    const variation = 0.75 + (Math.abs(nameHash) % 100) / 200;
    const frequency = globalFrequency * variation;
    const traffic =
      totalVisitors > 0
        ? Number((referrerRow.visitors / totalVisitors).toFixed(6))
        : 0;

    return {
      referrer: referrerRow.referrer,
      visitors: referrerRow.visitors,
      sessions: referrerRow.sessions,
      metrics: {
        duration: avgDuration,
        engagement,
        depth,
        loyalty,
        frequency,
        traffic,
      },
    };
  });

  return { ok: true, data };
}

export { generateDemoClientCrossBreakdown } from "@/lib/realtime/mock/client-cross";
