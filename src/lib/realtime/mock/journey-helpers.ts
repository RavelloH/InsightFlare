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
} from "@/lib/realtime/mock/visitor-pool";
function hasValidDemoCoordinate(visit: DemoVisitFact): boolean {
  return (
    Number.isFinite(visit.latitude) &&
    Number.isFinite(visit.longitude) &&
    visit.latitude >= -90 &&
    visit.latitude <= 90 &&
    visit.longitude >= -180 &&
    visit.longitude <= 180
  );
}

export function createDemoJourneyLocationPoints(
  visits: DemoVisitFact[],
): Array<Record<string, unknown>> {
  return [...visits]
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.visitId.localeCompare(right.visitId),
    )
    .filter(hasValidDemoCoordinate)
    .map((visit) => ({
      latitude: visit.latitude,
      longitude: visit.longitude,
      timestampMs: visit.startedAt,
      country: visit.country,
      region: visit.regionName || visit.region,
      regionCode: visit.regionCode,
      city: visit.cityName || visit.city,
    }));
}

export function createDemoJourneySession(
  sessionId: string,
  visits: DemoVisitFact[],
): Record<string, unknown> | null {
  if (visits.length === 0) return null;
  const ordered = [...visits].sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.visitId.localeCompare(right.visitId),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return null;
  const endedAt = Math.max(
    ...ordered.map((visit) => visit.startedAt + Math.max(0, visit.durationMs)),
    last.startedAt,
  );
  const durationMs = ordered.reduce(
    (sum, visit) => sum + Math.max(0, visit.durationMs),
    0,
  );
  const screen = parseDemoScreenSize(first.screenSize);
  const firstGeo = ordered.find(hasValidDemoCoordinate);
  return {
    sessionId,
    visitorId: first.visitorId,
    startedAt: first.startedAt,
    endedAt,
    durationMs,
    active: endedAt > Date.now() - 5 * 60 * 1000,
    views: ordered.length,
    events: ordered.filter((visit) => visit.eventType !== "pageview").length,
    bounce: ordered.length <= 1,
    entryPath: first.pathname,
    exitPath: last.pathname,
    referrerHost: first.referrerHost,
    referrerUrl: first.referrerUrl,
    country: first.country,
    region: first.regionName || first.region,
    regionCode: first.regionCode,
    city: first.cityName || first.city,
    latitude: firstGeo?.latitude ?? null,
    longitude: firstGeo?.longitude ?? null,
    browser: first.browser,
    browserVersion: first.browserVersion,
    os: demoOperatingSystemLabel(first.osVersion),
    osVersion: first.osVersion,
    deviceType: first.deviceType,
    screenWidth: screen.screenWidth,
    screenHeight: screen.screenHeight,
  };
}

export function demoVisitsBySession(
  visits: DemoVisitFact[],
): Map<string, DemoVisitFact[]> {
  const bySession = new Map<string, DemoVisitFact[]>();
  for (const visit of visits) {
    const bucket = bySession.get(visit.sessionId) ?? [];
    bucket.push(visit);
    bySession.set(visit.sessionId, bucket);
  }
  return bySession;
}

export function createDemoJourneyEvents(
  visits: DemoVisitFact[],
  options?: { includeSessionStart?: boolean; includeSessionEnd?: boolean },
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const bySession = demoVisitsBySession(visits);

  if (options?.includeSessionStart || options?.includeSessionEnd) {
    for (const [sessionId, sessionVisits] of bySession.entries()) {
      const session = createDemoJourneySession(sessionId, sessionVisits);
      if (!session) continue;
      if (options?.includeSessionStart) {
        events.push({
          id: `session-start:${sessionId}`,
          kind: "session_start",
          eventType: "session start",
          occurredAt: session.startedAt,
          visitId: "",
          sessionId,
          visitorId: session.visitorId,
          pathname: session.entryPath,
          title: "",
          hostname: "",
          referrerHost: session.referrerHost,
          referrerUrl: session.referrerUrl,
          country: session.country,
          region: session.region,
          city: session.city,
          browser: session.browser,
          browserVersion: session.browserVersion,
          os: session.os,
          osVersion: session.osVersion,
          deviceType: session.deviceType,
          screenWidth: session.screenWidth,
          screenHeight: session.screenHeight,
          durationMs: 0,
        });
      }

      if (options?.includeSessionEnd && !session.active) {
        const sessionStartedAt = Number(session.startedAt ?? 0);
        const sessionEndedAt = Number(session.endedAt ?? sessionStartedAt);
        const lastVisit = [...sessionVisits].sort(
          (left, right) =>
            right.startedAt - left.startedAt ||
            right.visitId.localeCompare(left.visitId),
        )[0];
        if (lastVisit && Number.isFinite(sessionEndedAt)) {
          const screen = parseDemoScreenSize(lastVisit.screenSize);
          events.push({
            id: `session-leave:${sessionId}`,
            kind: "leave",
            eventType: "leave",
            occurredAt: Math.max(sessionEndedAt, sessionStartedAt),
            visitId: lastVisit.visitId,
            sessionId,
            visitorId: lastVisit.visitorId,
            pathname: session.exitPath || lastVisit.pathname,
            title: lastVisit.title,
            hostname: lastVisit.hostname,
            referrerHost: lastVisit.referrerHost,
            referrerUrl: lastVisit.referrerUrl,
            country: lastVisit.country,
            region: lastVisit.regionName || lastVisit.region,
            city: lastVisit.cityName || lastVisit.city,
            browser: lastVisit.browser,
            browserVersion: lastVisit.browserVersion,
            os: demoOperatingSystemLabel(lastVisit.osVersion),
            osVersion: lastVisit.osVersion,
            deviceType: lastVisit.deviceType,
            screenWidth: screen.screenWidth,
            screenHeight: screen.screenHeight,
            durationMs: 0,
          });
        }
      }
    }
  }

  for (const visit of visits) {
    const screen = parseDemoScreenSize(visit.screenSize);
    const base = {
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      visitorId: visit.visitorId,
      pathname: visit.pathname,
      title: visit.title,
      hostname: visit.hostname,
      referrerHost: visit.referrerHost,
      referrerUrl: visit.referrerUrl,
      country: visit.country,
      region: visit.regionName || visit.region,
      city: visit.cityName || visit.city,
      browser: visit.browser,
      browserVersion: visit.browserVersion,
      os: demoOperatingSystemLabel(visit.osVersion),
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      screenWidth: screen.screenWidth,
      screenHeight: screen.screenHeight,
      durationMs: 0,
    };
    events.push({
      ...base,
      id: visit.visitId,
      kind: "pageview",
      eventType: "pageview",
      occurredAt: visit.startedAt,
      durationMs: Math.max(0, visit.durationMs),
    });
    if (visit.eventType !== "pageview") {
      events.push({
        ...base,
        id: `${visit.visitId}:${visit.eventType}`,
        kind: "custom",
        eventType: visit.eventType,
        occurredAt: Math.min(
          visit.startedAt + 1000,
          visit.startedAt + Math.max(1000, visit.durationMs),
        ),
      });
    }
  }

  return events.sort(
    (left, right) =>
      Number(right.occurredAt ?? 0) - Number(left.occurredAt ?? 0) ||
      String(right.id ?? "").localeCompare(String(left.id ?? "")),
  );
}

export function summarizeDemoVisitedPages(
  events: Array<Record<string, unknown>>,
) {
  const pages = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "pageview") continue;
    const pathname = String(event.pathname || "/").trim() || "/";
    pages.set(pathname, (pages.get(pathname) ?? 0) + 1);
  }
  return Array.from(pages.entries())
    .map(([pathname, views]) => ({ pathname, views }))
    .sort(
      (left, right) =>
        right.views - left.views || left.pathname.localeCompare(right.pathname),
    )
    .slice(0, 50);
}

export function summarizeDemoEventDistribution(
  events: Array<Record<string, unknown>>,
) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const eventType = String(event.eventType || event.kind || "event");
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([eventType, count]) => ({ eventType, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.eventType.localeCompare(right.eventType),
    )
    .slice(0, 50);
}

export function demoReportingDateKey(
  timestampMs: number,
  timeZone: string,
): string {
  const parts = zonedParts(timestampMs, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function summarizeDemoActivity(
  events: Array<Record<string, unknown>>,
  timeZone: string,
) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const occurredAt = Number(event.occurredAt ?? 0);
    if (!Number.isFinite(occurredAt) || occurredAt <= 0) continue;
    const date = demoReportingDateKey(occurredAt, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function demoJourneyPercentile(
  values: number[],
  percentileValue: number,
): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function demoAverageGapMs(values: number[]): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += sorted[index] - sorted[index - 1];
  }
  return Math.round(total / (sorted.length - 1));
}

export type DemoVisitorSortKey =
  | "firstSeenAt"
  | "lastSeenAt"
  | "sessions"
  | "views";
export type DemoSessionSortKey = "startedAt" | "durationMs" | "views";

function parseDemoSortDirection(
  value: string | number | undefined,
): DemoSortDirection {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "asc"
    ? "asc"
    : "desc";
}

export function parseDemoVisitorSort(params: Record<string, string | number>): {
  key: DemoVisitorSortKey;
  direction: DemoSortDirection;
} {
  const key = String(params.sortBy ?? "").trim();
  if (
    key === "firstSeenAt" ||
    key === "lastSeenAt" ||
    key === "sessions" ||
    key === "views"
  ) {
    return { key, direction: parseDemoSortDirection(params.sortDir) };
  }
  return { key: "lastSeenAt", direction: "desc" };
}

export function parseDemoSessionSort(params: Record<string, string | number>): {
  key: DemoSessionSortKey;
  direction: DemoSortDirection;
} {
  const key = String(params.sortBy ?? "").trim();
  if (key === "startedAt" || key === "durationMs" || key === "views") {
    return { key, direction: parseDemoSortDirection(params.sortDir) };
  }
  return { key: "startedAt", direction: "desc" };
}

export function compareDemoNumericField(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
  direction: DemoSortDirection,
): number {
  const diff = Number(left[key] ?? 0) - Number(right[key] ?? 0);
  return direction === "asc" ? diff : -diff;
}
