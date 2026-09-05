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
import { demoPage } from "@/lib/realtime/mock/pagination";
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

  const rows = Array.from(buckets.entries())
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
    );
  const page = demoPage(
    rows,
    params,
    {
      operation: "visitors",
      siteId,
      from,
      to,
      filters,
      search,
      sort: { key: sort.key, direction: sort.direction },
    },
    80,
    120,
  );

  return {
    ok: true,
    data: page,
  };
}

export function generateDemoSessions(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
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
  const rows = Array.from(demoVisitsBySession(filtered.visits).entries())
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
    );
  const page = demoPage(
    rows,
    params,
    {
      operation: "sessions",
      siteId,
      from,
      to,
      filters,
      search,
      sort: { key: sort.key, direction: sort.direction },
    },
    80,
    120,
  );

  return {
    ok: true,
    data: page,
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
  const allEvents = createDemoJourneyEvents(detailVisits, {
    includeSessionStart: true,
  });
  const events =
    "from" in params || "to" in params
      ? allEvents.filter((event) => {
          const occurredAt = Number(event.occurredAt ?? 0);
          return occurredAt >= from && occurredAt < to;
        })
      : allEvents;
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
  const allEvents = createDemoJourneyEvents(detailVisits, {
    includeSessionStart: true,
    includeSessionEnd: true,
  });
  const events =
    "from" in params || "to" in params
      ? allEvents.filter((event) => {
          const occurredAt = Number(event.occurredAt ?? 0);
          return occurredAt >= from && occurredAt < to;
        })
      : allEvents;
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

const DEMO_EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

type DemoStandardJourneyEventKind = "pageview" | "session_start" | "leave";

function demoStandardEventKind(
  value: string,
): DemoStandardJourneyEventKind | null {
  return value === "pageview" || value === "session_start" || value === "leave"
    ? value
    : null;
}

function demoVisitPerformance(visit: DemoVisitFact) {
  return {
    ttfb: Math.max(45, Math.round(80 + visit.durationMs * 0.02)),
    fcp: Math.max(120, Math.round(260 + visit.durationMs * 0.03)),
    lcp: Math.max(280, Math.round(620 + visit.durationMs * 0.05)),
    cls: Number((0.02 + (visit.durationMs % 17) / 1000).toFixed(3)),
    inp: Math.max(35, Math.round(110 + visit.durationMs * 0.01)),
  };
}

/**
 * Resolves the standard JourneyEvent detail used by the session and visitor
 * drawers. It intentionally shares the journey-event fixtures and never
 * includes custom-event payload data.
 */
export function generateDemoJourneyEventDetail(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventId = String(params.eventId ?? "").trim();
  if (!eventId) return { ok: true, data: null };

  const rawEventKind = String(params.eventKind ?? "").trim();
  const eventKind = rawEventKind
    ? demoStandardEventKind(rawEventKind)
    : undefined;
  if (rawEventKind && !eventKind) return { ok: true, data: null };

  const from = parseDemoNumber(params.from, Date.now() - 7 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const requestedSessionId = String(params.sessionId ?? "").trim();
  const sessionVisits = requestedSessionId
    ? filtered.visits.filter((visit) => visit.sessionId === requestedSessionId)
    : filtered.visits;
  const detailVisits =
    requestedSessionId && sessionVisits.length === 0
      ? (() => {
          const fallbackVisitorId = fallbackDemoVisitorId(
            siteId,
            requestedSessionId,
          );
          return fallbackVisitorId
            ? [
                createFallbackDemoVisit(
                  siteId,
                  fallbackVisitorId,
                  from,
                  to,
                  requestedSessionId,
                ),
              ]
            : [];
        })()
      : sessionVisits;
  const events = createDemoJourneyEvents(detailVisits, {
    includeSessionStart: true,
    includeSessionEnd: true,
  });
  const event = events.find(
    (candidate) =>
      String(candidate.id ?? "") === eventId &&
      (eventKind === undefined || candidate.kind === eventKind),
  );
  if (!event) return { ok: true, data: null };
  const occurredAt = Number(event.occurredAt ?? 0);
  if (!Number.isFinite(occurredAt) || occurredAt < from || occurredAt >= to) {
    return { ok: true, data: null };
  }

  const resolvedSessionId = String(event.sessionId ?? "");
  const resolvedSessionVisits = detailVisits.filter(
    (visit) => visit.sessionId === resolvedSessionId,
  );
  const session = createDemoJourneySession(
    resolvedSessionId,
    resolvedSessionVisits,
  ) as Record<string, unknown>;
  const orderedVisits = [...resolvedSessionVisits].sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.visitId.localeCompare(right.visitId),
  );
  const sourceVisit =
    resolvedSessionVisits.find(
      (visit) => visit.visitId === String(event.visitId ?? ""),
    ) ?? (event.kind === "leave" ? orderedVisits.at(-1) : orderedVisits[0]);
  const resolvedSourceVisit = sourceVisit as DemoVisitFact;
  const previousVisit =
    event.kind === "pageview"
      ? (orderedVisits
          .filter(
            (visit) =>
              visit.startedAt < resolvedSourceVisit.startedAt ||
              (visit.startedAt === resolvedSourceVisit.startedAt &&
                visit.visitId < resolvedSourceVisit.visitId),
          )
          .at(-1) ?? null)
      : null;
  const screen = parseDemoScreenSize(resolvedSourceVisit.screenSize);
  const sourceEndedAt =
    resolvedSourceVisit.startedAt + Math.max(0, resolvedSourceVisit.durationMs);
  const isBoundaryEvent = event.kind !== "pageview";
  const startedAt = isBoundaryEvent
    ? Number(session.startedAt)
    : resolvedSourceVisit.startedAt;
  const lastActivityAt = isBoundaryEvent
    ? Number(session.endedAt)
    : sourceEndedAt;
  const durationMs = isBoundaryEvent
    ? Number(session.durationMs)
    : Math.max(0, resolvedSourceVisit.durationMs);
  const visitorId = String(event.visitorId ?? "");
  const country = String(event.country ?? "");
  const queryString = demoQueryStringForVisit(resolvedSourceVisit);
  const hash = demoHashFragmentForVisit(resolvedSourceVisit);

  return {
    ok: true,
    data: {
      event: {
        eventId,
        eventName: String(event.eventType ?? ""),
        eventKind: String(event.kind ?? "pageview"),
        occurredAt,
        receivedAt: occurredAt,
        sequence: 0,
        visitId: String(event.visitId ?? ""),
        sessionId: resolvedSessionId,
        visitorId,
        pathname: String(event.pathname ?? ""),
        title: String(event.title ?? ""),
        hostname: String(event.hostname ?? ""),
        referrerHost: String(event.referrerHost ?? ""),
        country,
        region: String(event.region ?? ""),
        browser: String(event.browser ?? ""),
        browserVersion: String(event.browserVersion ?? ""),
        os: String(event.os ?? ""),
        osVersion: String(event.osVersion ?? ""),
        deviceType: String(event.deviceType ?? ""),
        nodeCount: 0,
        valueCount: 0,
      },
      context: {
        visitId: String(event.visitId ?? ""),
        sessionId: resolvedSessionId,
        visitorId,
        userId: visitorId ? `demo-user-${visitorId}` : "",
        userName: visitorId
          ? `Demo visitor ${visitorId.slice(-6).toUpperCase()}`
          : "",
        pathname: String(event.pathname ?? ""),
        queryString,
        hash,
        title: String(event.title ?? ""),
        hostname: String(event.hostname ?? ""),
        referrerUrl: String(event.referrerUrl ?? ""),
        referrerHost: String(event.referrerHost ?? ""),
        utmSource: resolvedSourceVisit.utmSource ?? "",
        utmMedium: resolvedSourceVisit.utmMedium ?? "",
        utmCampaign: resolvedSourceVisit.utmCampaign ?? "",
        utmTerm: "",
        utmContent: "",
        isEU: DEMO_EU_COUNTRIES.has(country.trim().toUpperCase()),
        country,
        region: String(event.region ?? ""),
        regionCode: resolvedSourceVisit.regionCode,
        city: String(event.city ?? ""),
        continent: resolvedSourceVisit.continent,
        latitude: resolvedSourceVisit.latitude,
        longitude: resolvedSourceVisit.longitude,
        postalCode: `${resolvedSourceVisit.country}-${resolvedSourceVisit.regionCode || "global"}`,
        metroCode: `${resolvedSourceVisit.country}-${resolvedSourceVisit.regionCode || "global"}`,
        timezone: resolvedSourceVisit.timezone,
        organization: resolvedSourceVisit.organization,
        browser: String(event.browser ?? ""),
        browserVersion: String(event.browserVersion ?? ""),
        os: String(event.os ?? ""),
        osVersion: String(event.osVersion ?? ""),
        deviceType: String(event.deviceType ?? ""),
        userAgent: `Mozilla/5.0 (${event.os}; ${event.deviceType}) AppleWebKit/537.36 ${event.browser}/${event.browserVersion}`,
        language: resolvedSourceVisit.language,
        screenWidth: screen.screenWidth,
        screenHeight: screen.screenHeight,
        status: isBoundaryEvent
          ? session.active
            ? "open"
            : "complete"
          : "completed",
        startedAt,
        previousVisitId: previousVisit?.visitId ?? "",
        previousVisitStartedAt: previousVisit?.startedAt ?? null,
        lastActivityAt,
        endedAt: isBoundaryEvent ? lastActivityAt : sourceEndedAt,
        finalizedAt: isBoundaryEvent ? null : sourceEndedAt + 80,
        durationMs,
        durationSource: isBoundaryEvent ? "" : "mock",
        exitReason: isBoundaryEvent ? "" : "navigation",
        performance: isBoundaryEvent
          ? { ttfb: null, fcp: null, lcp: null, cls: null, inp: null }
          : demoVisitPerformance(resolvedSourceVisit),
      },
    },
  };
}
