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
import { summarizeDemoJourneyPerformance } from "@/lib/realtime/mock/analytics";
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
  compareDemoNumericField,
  createDemoJourneyEvents,
  createDemoJourneyLocationPoints,
  createDemoJourneySession,
  demoAverageGapMs,
  demoJourneyPercentile,
  demoReportingDateKey,
  demoVisitsBySession,
  parseDemoSessionSort,
  parseDemoVisitorSort,
  summarizeDemoActivity,
  summarizeDemoEventDistribution,
  summarizeDemoVisitedPages,
} from "@/lib/realtime/mock/journey-helpers";
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
  demoVisitMatchesJourneySearch,
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
  visitorIndexFromId,
} from "@/lib/realtime/mock/visitor-pool";

function isDemoVisitorIdForSite(siteId: string, visitorId: string): boolean {
  const normalizedSiteId = siteId.trim();
  const normalizedVisitorId = visitorId.trim();
  if (!normalizedSiteId || !normalizedVisitorId) return false;
  if (!normalizedVisitorId.startsWith(`v-${normalizedSiteId.slice(-3)}-`)) {
    return false;
  }
  return Number.isFinite(visitorIndexFromId(normalizedVisitorId));
}

function fallbackDemoSessionId(siteId: string, visitorId: string): string {
  return `${siteId}-demo-${visitorId}`;
}

function fallbackDemoVisitorId(
  siteId: string,
  sessionId: string,
): string | null {
  const prefix = `${siteId}-demo-`;
  const visitorId = sessionId.startsWith(prefix)
    ? sessionId.slice(prefix.length).trim()
    : "";
  return isDemoVisitorIdForSite(siteId, visitorId) ? visitorId : null;
}

function createFallbackDemoVisit(
  siteId: string,
  visitorId: string,
  from: number,
  to: number,
  sessionId = fallbackDemoSessionId(siteId, visitorId),
): DemoVisitFact {
  const profile = findSiteProfile(siteId);
  const fingerprint = getVisitorFingerprint(siteId, visitorId);
  const pathname = normalizePath(profile.paths[0] || "/") || "/";
  const title = profile.titles[0]?.trim() || titleFromPath(pathname);
  const startedAt = Math.max(from, Math.min(to - 1, Date.now() - 30_000));

  return {
    visitId: `${sessionId}-v-000`,
    sessionId,
    visitorId,
    startedAt,
    pathname,
    title,
    hostname: profile.domain,
    referrerHost: "",
    referrerUrl: "",
    browser: fingerprint.browser,
    browserVersion: fingerprint.browserVersion,
    osVersion: fingerprint.osVersion,
    deviceType: fingerprint.deviceType,
    language: fingerprint.language,
    screenSize: fingerprint.screenSize,
    country: fingerprint.country,
    regionCode: fingerprint.regionCode,
    regionName: fingerprint.regionName,
    region: fingerprint.region,
    cityName: fingerprint.cityName,
    city: fingerprint.city,
    continent: fingerprint.continent,
    timezone: fingerprint.timezone,
    organization: fingerprint.organization,
    latitude: fingerprint.latitude,
    longitude: fingerprint.longitude,
    eventType: profile.eventNames[0] || "pageview",
    durationMs: 30_000,
  };
}

export function generateDemoVisitors(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const paged = params.cursor !== undefined || params.pageSize !== undefined;
  const pageSize = paged
    ? parseDemoLimit(params.pageSize, 80, 1, 120)
    : parseDemoLimit(params.limit, 100, 1, 500);
  const offset = paged ? parseDemoLimit(params.cursor, 0, 0, 1_000_000) : 0;
  const from = parseDemoNumber(params.from, Date.now() - 7 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const sort = parseDemoVisitorSort(params);
  const search = normalizeDemoSearch(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const matchedVisitorIds = search
    ? new Set(
        filtered.visits
          .filter((visit) =>
            demoVisitMatchesJourneySearch(dataset, visit, search),
          )
          .map((visit) => visit.visitorId),
      )
    : null;

  const buckets = new Map<
    string,
    {
      firstSeenAt: number;
      lastSeenAt: number;
      views: number;
      sessions: Set<string>;
      events: number;
      firstVisit: DemoVisitFact;
      latestVisit: DemoVisitFact;
    }
  >();
  for (const visit of filtered.visits) {
    if (matchedVisitorIds && !matchedVisitorIds.has(visit.visitorId)) continue;
    const bucket = buckets.get(visit.visitorId) ?? {
      firstSeenAt: visit.startedAt,
      lastSeenAt: visit.startedAt,
      views: 0,
      sessions: new Set<string>(),
      events: 0,
      firstVisit: visit,
      latestVisit: visit,
    };
    if (visit.startedAt <= bucket.firstSeenAt) {
      bucket.firstSeenAt = visit.startedAt;
      bucket.firstVisit = visit;
    }
    if (visit.startedAt >= bucket.lastSeenAt) {
      bucket.lastSeenAt = visit.startedAt;
      bucket.latestVisit = visit;
    }
    bucket.views += dataset.viewWeight;
    bucket.sessions.add(visit.sessionId);
    if (visit.eventType !== "pageview") bucket.events += 1;
    buckets.set(visit.visitorId, bucket);
  }

  const requestedRows = Array.from(buckets.entries())
    .map(([visitorId, bucket]) => ({
      visitorId,
      sessionId: bucket.latestVisit.sessionId,
      firstSeenAt: bucket.firstSeenAt,
      lastSeenAt: bucket.lastSeenAt,
      views: Math.max(0, Math.round(bucket.views)),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
      events: bucket.events,
      country: bucket.latestVisit.country,
      region: bucket.latestVisit.regionName || bucket.latestVisit.region,
      regionCode: bucket.latestVisit.regionCode,
      city: bucket.latestVisit.cityName || bucket.latestVisit.city,
      referrerHost: bucket.firstVisit.referrerHost,
      referrerUrl: bucket.firstVisit.referrerUrl,
      browser: bucket.latestVisit.browser,
      browserVersion: bucket.latestVisit.browserVersion,
      os: demoOperatingSystemLabel(bucket.latestVisit.osVersion),
      osVersion: bucket.latestVisit.osVersion,
      deviceType: bucket.latestVisit.deviceType,
      screenWidth: parseDemoScreenSize(bucket.latestVisit.screenSize)
        .screenWidth,
      screenHeight: parseDemoScreenSize(bucket.latestVisit.screenSize)
        .screenHeight,
    }))
    .sort(
      (left, right) =>
        compareDemoNumericField(left, right, sort.key, sort.direction) ||
        right.lastSeenAt - left.lastSeenAt ||
        right.views - left.views ||
        left.visitorId.localeCompare(right.visitorId),
    )
    .slice(offset, offset + pageSize + (paged ? 1 : 0));
  const hasMore = paged && requestedRows.length > pageSize;
  const rows = hasMore ? requestedRows.slice(0, pageSize) : requestedRows;

  return {
    ok: true,
    data: rows,
    meta: {
      pageSize,
      returned: rows.length,
      hasMore,
      nextCursor: hasMore ? String(offset + pageSize) : null,
    },
  };
}

export function generateDemoSessions(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const paged = params.cursor !== undefined || params.pageSize !== undefined;
  const pageSize = paged
    ? parseDemoLimit(params.pageSize, 80, 1, 120)
    : parseDemoLimit(params.limit, 100, 1, 500);
  const offset = paged ? parseDemoLimit(params.cursor, 0, 0, 1_000_000) : 0;
  const from = parseDemoNumber(params.from, Date.now() - 7 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const sort = parseDemoSessionSort(params);
  const search = normalizeDemoSearch(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const matchedSessionIds = search
    ? new Set(
        filtered.visits
          .filter((visit) =>
            demoVisitMatchesJourneySearch(dataset, visit, search),
          )
          .map((visit) => visit.sessionId),
      )
    : null;
  const requestedRows = Array.from(
    demoVisitsBySession(filtered.visits).entries(),
  )
    .filter(([sessionId]) =>
      matchedSessionIds ? matchedSessionIds.has(sessionId) : true,
    )
    .map(([sessionId, visits]) => createDemoJourneySession(sessionId, visits))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .sort(
      (left, right) =>
        compareDemoNumericField(left, right, sort.key, sort.direction) ||
        Number(right.startedAt ?? 0) - Number(left.startedAt ?? 0) ||
        String(left.sessionId ?? "").localeCompare(
          String(right.sessionId ?? ""),
        ),
    )
    .slice(offset, offset + pageSize + (paged ? 1 : 0));
  const hasMore = paged && requestedRows.length > pageSize;
  const rows = hasMore ? requestedRows.slice(0, pageSize) : requestedRows;

  return {
    ok: true,
    data: rows,
    meta: {
      pageSize,
      returned: rows.length,
      hasMore,
      nextCursor: hasMore ? String(offset + pageSize) : null,
    },
  };
}

export function generateDemoVisitorDetail(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const visitorId = String(params.visitorId || "").trim();
  if (!visitorId) return { ok: true, data: null };
  const from = parseDemoNumber(params.from, Date.now() - 7 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const timeZone = parseDemoTimeZone(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const visits = filtered.visits.filter(
    (visit) => visit.visitorId === visitorId,
  );
  const detailVisits =
    visits.length > 0
      ? visits
      : isDemoVisitorIdForSite(siteId, visitorId)
        ? [createFallbackDemoVisit(siteId, visitorId, from, to)]
        : [];
  if (detailVisits.length === 0) return { ok: true, data: null };

  const sessions = Array.from(demoVisitsBySession(detailVisits).entries())
    .map(([sessionId, sessionVisits]) =>
      createDemoJourneySession(sessionId, sessionVisits),
    )
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .sort(
      (left, right) =>
        Number(right.startedAt ?? 0) - Number(left.startedAt ?? 0),
    );
  const events = createDemoJourneyEvents(detailVisits, {
    includeSessionStart: true,
  });
  const customEventCount = events.filter(
    (event) => event.kind === "custom",
  ).length;
  const latest =
    [...detailVisits].sort(
      (left, right) => right.startedAt - left.startedAt,
    )[0] ?? detailVisits[0];
  const earliest =
    [...detailVisits].sort(
      (left, right) => left.startedAt - right.startedAt,
    )[0] ?? detailVisits[0];
  const firstSeenAt = Math.min(...detailVisits.map((visit) => visit.startedAt));
  const lastSeenAt = Math.max(...detailVisits.map((visit) => visit.startedAt));
  const screen = parseDemoScreenSize(latest.screenSize);
  const durationValues = sessions.map((session) =>
    Number(session.durationMs ?? 0),
  );
  const totalDuration = durationValues.reduce((sum, value) => sum + value, 0);
  const daysActive = new Set(
    events
      .map((event) => Number(event.occurredAt ?? 0))
      .filter((value) => value > 0)
      .map((value) => demoReportingDateKey(value, timeZone)),
  ).size;
  const visitor = {
    visitorId,
    firstSeenAt,
    lastSeenAt,
    views: detailVisits.length,
    sessions: sessions.length,
    events: customEventCount,
    country: latest.country,
    region: latest.regionName || latest.region,
    city: latest.cityName || latest.city,
    referrerHost: earliest.referrerHost,
    referrerUrl: earliest.referrerUrl,
    browser: latest.browser,
    browserVersion: latest.browserVersion,
    os: demoOperatingSystemLabel(latest.osVersion),
    osVersion: latest.osVersion,
    deviceType: latest.deviceType,
    screenWidth: screen.screenWidth,
    screenHeight: screen.screenHeight,
  };

  return {
    ok: true,
    data: {
      visitor,
      metrics: {
        totalEvents: customEventCount,
        sessions: sessions.length,
        views: detailVisits.length,
        avgEventsPerSession:
          sessions.length > 0 ? customEventCount / sessions.length : 0,
        bounceRate:
          sessions.length > 0
            ? sessions.filter((session) => Boolean(session.bounce)).length /
              sessions.length
            : 0,
        avgDurationMs:
          sessions.length > 0 ? Math.round(totalDuration / sessions.length) : 0,
        p90DurationMs: demoJourneyPercentile(durationValues, 90),
        firstSeenAt,
        lastSeenAt,
        daysActive,
        conversionEvents: customEventCount,
        avgTimeBetweenSessionsMs: demoAverageGapMs(
          sessions.map((session) => Number(session.startedAt ?? 0)),
        ),
      },
      sessions,
      events,
      visitedPages: summarizeDemoVisitedPages(events),
      eventDistribution: summarizeDemoEventDistribution(events),
      activity: summarizeDemoActivity(events, timeZone),
      performance: summarizeDemoJourneyPerformance(siteId, detailVisits),
    },
  };
}

export function generateDemoSessionDetail(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return { ok: true, data: null };
  const from = parseDemoNumber(params.from, Date.now() - 7 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const visits = filtered.visits.filter(
    (visit) => visit.sessionId === sessionId,
  );
  const fallbackVisitorId =
    visits.length === 0 ? fallbackDemoVisitorId(siteId, sessionId) : null;
  const detailVisits =
    visits.length > 0
      ? visits
      : fallbackVisitorId
        ? [
            createFallbackDemoVisit(
              siteId,
              fallbackVisitorId,
              from,
              to,
              sessionId,
            ),
          ]
        : [];
  const session = createDemoJourneySession(sessionId, detailVisits);
  if (!session) return { ok: true, data: null };
  const events = createDemoJourneyEvents(detailVisits, {
    includeSessionStart: true,
    includeSessionEnd: true,
  });
  const locationPoints = createDemoJourneyLocationPoints(detailVisits);

  return {
    ok: true,
    data: {
      session,
      locationPoints,
      events,
      visitedPages: summarizeDemoVisitedPages(events),
      eventDistribution: summarizeDemoEventDistribution(events),
      performance: summarizeDemoJourneyPerformance(siteId, detailVisits),
    },
  };
}
