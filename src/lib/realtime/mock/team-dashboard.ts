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
  demoSitePublicSlug,
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
export function generateDemoTeamDashboard(
  teamId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const interval = String(params.interval || "day");
  const timeZone = parseDemoTimeZone(params);
  const now = Date.now();
  const span = to - from;

  const sites = teamSites.map((site) => {
    const metrics = computeMetrics(site.id, from, to);
    const prevMetrics = computeMetrics(site.id, Math.max(0, from - span), from);
    const cr = (cur: number, prev: number) =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    return {
      id: site.id,
      teamId: site.teamId,
      name: site.name,
      domain: site.domain,
      iconPath: site.iconPath,
      publicEnabled: true,
      publicSlug: demoSitePublicSlug(site),
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt:
        now - sInt(mulberry32(fnv1a(site.id)), 1, 14) * 24 * 3600 * 1000,
      overview: metrics,
      changeRates: {
        views: cr(metrics.views, prevMetrics.views),
        sessions: cr(metrics.sessions, prevMetrics.sessions),
        visitors: cr(metrics.visitors, prevMetrics.visitors),
        bounceRate: cr(metrics.bounceRate, prevMetrics.bounceRate),
        avgDurationMs: cr(metrics.avgDurationMs, prevMetrics.avgDurationMs),
        pagesPerSession: null,
      },
    };
  });

  const buckets = buildDemoTimeBuckets(
    from,
    to,
    parseDemoInterval(interval),
    timeZone,
  );
  const trend: Array<{
    bucket: number;
    timestampMs: number;
    sites: Array<{ siteId: string; views: number; visitors: number }>;
  }> = [];
  for (const bucket of buckets) {
    const ts = Math.max(from, bucket.fromMs);
    const end = Math.min(bucket.toMs, to);
    const sitesForBucket = teamSites.map((site) => {
      const views = integrateViews(site.id, ts, end);
      const r = siteRatios(site.id);
      const visitors = Math.max(
        views > 0 ? 1 : 0,
        Math.round(views * r.sessionsPerView * r.visitorsPerSession),
      );
      return { siteId: site.id, views, visitors };
    });
    trend.push({
      bucket: bucket.index,
      timestampMs: bucket.timestampMs,
      sites: sitesForBucket,
    });
  }

  return { ok: true, data: { sites, trend } };
}
