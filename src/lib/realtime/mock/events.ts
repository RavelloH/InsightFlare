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
  collectDemoEventFields,
  collectDemoEventFieldValues,
  createDemoCustomEventFacts,
  demoEventContextCards,
  demoEventDimensionRows,
  demoEventRecordFromFact,
  demoEventRecordPayload,
  demoEventSummaryCards,
  filterDemoCustomEventsByPayload,
  parseDemoEventRecordSort,
  sortDemoEventRecords,
} from "@/lib/realtime/mock/events-helpers";
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

export function generateDemoEventsSummary(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  );
  const sessions = new Set(events.map((event) => event.visit.sessionId));
  const visitors = new Set(events.map((event) => event.visit.visitorId));
  const eventNames = new Set(events.map((event) => event.eventName));
  const sessionCount = Math.max(
    0,
    Math.round(weightedSessionCount(dataset, sessions)),
  );

  return {
    ok: true,
    summary: {
      events: events.length,
      eventTypes: eventNames.size,
      sessions: sessionCount,
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, visitors)),
      ),
      avgEventsPerSession: sessionCount > 0 ? events.length / sessionCount : 0,
    },
    cards: demoEventSummaryCards(dataset, events, 100),
  };
}

export function generateDemoEventsTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const limit = parseDemoLimit(params.limit, 8, 1, 12);
  const filters = parseDemoFilters(params);
  const eventName = normalizeDemoFilterValue(params.eventName);
  const timeZone = parseDemoTimeZone(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const allEvents = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  ).filter((event) => !eventName || event.eventName === eventName);
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const seriesRows = demoEventDimensionRows(
    dataset,
    allEvents,
    limit,
    (event) => event.eventName,
  );
  const topNames = new Set(seriesRows.map((row) => row.label));
  const usedKeys = new Set<string>([DEMO_SHARE_TREND_OTHER_KEY]);
  const keyByName = new Map<string, string>();
  const series: Array<{
    key: string;
    eventName: string;
    label: string;
    events: number;
    sessions: number;
    visitors: number;
    isOther?: boolean;
  }> = seriesRows.map((row) => {
    const key = createDemoShareTrendSeriesKey(row.label, usedKeys, "event");
    keyByName.set(row.label, key);
    return {
      key,
      eventName: row.label,
      label: row.label,
      events: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    };
  });

  const hasOther = allEvents.some((event) => !topNames.has(event.eventName));
  if (hasOther) {
    const otherEvents = allEvents.filter(
      (event) => !topNames.has(event.eventName),
    );
    const otherSessions = new Set(
      otherEvents.map((event) => event.visit.sessionId),
    );
    const otherVisitors = new Set(
      otherEvents.map((event) => event.visit.visitorId),
    );
    series.push({
      key: DEMO_SHARE_TREND_OTHER_KEY,
      eventName: DEMO_SHARE_TREND_OTHER_LABEL,
      label: DEMO_SHARE_TREND_OTHER_LABEL,
      events: otherEvents.length,
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, otherSessions)),
      ),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, otherVisitors)),
      ),
      isOther: true,
    });
  }

  const data = buckets.map((bucket) => ({
    bucket: bucket.index,
    timestampMs: bucket.timestampMs,
    totalEvents: 0,
    eventsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
  }));

  for (const event of allEvents) {
    const bucket = findDemoTimeBucketIndex(buckets, event.occurredAt);
    if (bucket === null) continue;
    const key =
      keyByName.get(event.eventName) ??
      (hasOther ? DEMO_SHARE_TREND_OTHER_KEY : null);
    if (!key) continue;
    const point = data[bucket];
    if (!point) continue;
    point.eventsBySeries[key] = Number(point.eventsBySeries[key] ?? 0) + 1;
    point.totalEvents += 1;
  }

  return {
    ok: true,
    interval,
    series,
    data,
  };
}

export function generateDemoEventsRecords(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const pageSize = parseDemoLimit(params.pageSize, 80, 1, 120);
  const filters = parseDemoFilters(params);
  const eventName = normalizeDemoFilterValue(params.eventName);
  const search = normalizeDemoSearch(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  ).filter((event) => {
    if (eventName && event.eventName !== eventName) return false;
    return demoValuesIncludeSearch(search, [
      event.eventName,
      event.eventId,
      event.visit.visitId,
      event.visit.sessionId,
      event.visit.visitorId,
      event.visit.pathname,
      event.visit.title,
      event.visit.hostname,
    ]);
  });
  const sorted = sortDemoEventRecords(events, parseDemoEventRecordSort(params));
  const offset =
    params.cursor !== undefined
      ? parseDemoLimit(params.cursor, 0, 0, 1_000_000)
      : (parseDemoLimit(params.page, 1, 1, 10_000) - 1) * pageSize;
  const requestedRows = sorted.slice(offset, offset + pageSize + 1);
  const hasMore = requestedRows.length > pageSize;
  const currentRows = requestedRows.slice(0, pageSize);

  return {
    ok: true,
    data: currentRows.map(demoEventRecordFromFact),
    meta: {
      pageSize,
      returned: currentRows.length,
      hasMore,
      nextCursor: hasMore ? String(offset + pageSize) : null,
    },
  };
}

export function generateDemoEventTypeDetail(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const allEvents = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  );
  const events = allEvents.filter((event) => event.eventName === eventName);
  const sessions = new Set(events.map((event) => event.visit.sessionId));
  const visitors = new Set(events.map((event) => event.visit.visitorId));
  const interval = parseDemoInterval(params.interval);
  const timeZone = parseDemoTimeZone(params);
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const trendBuckets = buckets.map((bucket) => ({
    bucket: bucket.index,
    timestampMs: bucket.timestampMs,
    events: 0,
    visitors: new Set<string>(),
  }));
  for (const event of events) {
    const bucketIndex = findDemoTimeBucketIndex(buckets, event.occurredAt);
    if (bucketIndex === null) continue;
    const bucket = trendBuckets[bucketIndex];
    if (!bucket) continue;
    bucket.events += dataset.viewWeight;
    bucket.visitors.add(event.visit.visitorId);
  }
  const sessionCount = Math.max(
    0,
    Math.round(weightedSessionCount(dataset, sessions)),
  );

  return {
    ok: true,
    eventName,
    summary: {
      events: events.length,
      eventTypes: eventName ? 1 : 0,
      sessions: sessionCount,
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, visitors)),
      ),
      avgEventsPerSession: sessionCount > 0 ? events.length / sessionCount : 0,
      shareOfAllEvents:
        allEvents.length > 0 ? events.length / allEvents.length : 0,
    },
    trend: {
      data: trendBuckets.map((bucket) => ({
        bucket: bucket.bucket,
        timestampMs: bucket.timestampMs,
        events: Math.max(0, Math.round(bucket.events)),
        visitors: Math.max(
          0,
          Math.round(weightedVisitorCount(dataset, bucket.visitors)),
        ),
      })),
    },
    breakdowns: {
      pages: demoEventDimensionRows(
        dataset,
        events,
        8,
        (event) => event.visit.pathname,
      ),
      countries: demoEventDimensionRows(
        dataset,
        events,
        8,
        (event) => event.visit.country,
      ),
      devices: demoEventDimensionRows(
        dataset,
        events,
        8,
        (event) => event.visit.deviceType,
      ),
      browsers: demoEventDimensionRows(
        dataset,
        events,
        8,
        (event) => event.visit.browser,
      ),
    },
    cards: demoEventContextCards(dataset, events, 100),
    fields: collectDemoEventFields(events, 100),
  };
}

export function generateDemoEventTypeContext(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const limit = parseDemoLimit(params.limit, 100, 1, 100);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  ).filter((event) => event.eventName === eventName);

  return {
    ok: true,
    eventName,
    cards: demoEventContextCards(dataset, events, limit),
  };
}

export function generateDemoEventFields(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";
  if (!eventName) return { ok: true, eventName, fields: [] };

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  ).filter((event) => event.eventName === eventName);

  return {
    ok: true,
    eventName,
    fields: collectDemoEventFields(
      events,
      parseDemoLimit(params.limit, 100, 1, 200),
    ),
  };
}

export function generateDemoEventTypeFieldValues(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";
  const fieldPath = String(params.fieldPath ?? "");
  const fieldValueType = normalizeDemoFilterValue(params.fieldValueType) ?? "";
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const limit = parseDemoLimit(params.limit, 25, 1, 100);
  const search = normalizeDemoSearch(params);
  if (!eventName || !fieldPath || !fieldValueType) {
    return {
      ok: true,
      fieldPath,
      fieldValueType,
      data: [],
    };
  }
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
  ).filter((event) => event.eventName === eventName);

  return {
    ok: true,
    fieldPath,
    fieldValueType,
    data: collectDemoEventFieldValues(events, fieldPath, fieldValueType, limit)
      .filter((row) => demoValuesIncludeSearch(search, [row.value]))
      .slice(0, limit),
  };
}

export function generateDemoEventRecordDetail(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, Date.now() - 30 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const eventId = normalizeDemoFilterValue(params.eventId) ?? "";
  const dataset = buildDemoFactDataset(siteId, from, to);
  const event =
    createDemoCustomEventFacts(dataset.visits).find(
      (item) => item.eventId === eventId,
    ) ?? createDemoCustomEventFacts(dataset.visits)[0];
  if (!event) return { ok: true, data: null };
  const record = demoEventRecordFromFact(event);
  const queryString =
    [
      event.visit.utmSource
        ? `utm_source=${encodeURIComponent(event.visit.utmSource)}`
        : "",
      event.visit.utmMedium
        ? `utm_medium=${encodeURIComponent(event.visit.utmMedium)}`
        : "",
      event.visit.utmCampaign
        ? `utm_campaign=${encodeURIComponent(event.visit.utmCampaign)}`
        : "",
    ]
      .filter(Boolean)
      .join("&") || "ref=direct";
  const [screenWidth, screenHeight] = event.visit.screenSize
    .split("x")
    .map((value) => Number(value));
  const endedAt = event.visit.startedAt + event.visit.durationMs;
  const performance = {
    ttfb: Math.max(45, Math.round(80 + event.visit.durationMs * 0.02)),
    fcp: Math.max(120, Math.round(260 + event.visit.durationMs * 0.03)),
    lcp: Math.max(280, Math.round(620 + event.visit.durationMs * 0.05)),
    cls: Number((0.02 + (event.visit.durationMs % 17) / 1000).toFixed(3)),
    inp: Math.max(35, Math.round(110 + event.visit.durationMs * 0.01)),
  };
  return {
    ok: true,
    data: {
      event: { ...record, eventKind: "custom_event" },
      context: {
        visitId: record.visitId,
        sessionId: record.sessionId,
        visitorId: record.visitorId,
        userId: `demo-user-${event.visit.visitorId}`,
        userName: `Demo visitor ${event.visit.visitorId.slice(-6).toUpperCase()}`,
        pathname: record.pathname,
        queryString,
        hash: "",
        title: record.title,
        hostname: record.hostname,
        referrerUrl: event.visit.referrerUrl,
        referrerHost: record.referrerHost,
        utmSource: event.visit.utmSource ?? "",
        utmMedium: event.visit.utmMedium ?? "",
        utmCampaign: event.visit.utmCampaign ?? "",
        utmTerm: "",
        utmContent: "",
        isEU: new Set([
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
        ]).has(event.visit.country.trim().toUpperCase()),
        country: record.country,
        region: record.region,
        regionCode: event.visit.regionCode,
        city: event.visit.city,
        continent: event.visit.continent,
        latitude: event.visit.latitude,
        longitude: event.visit.longitude,
        postalCode: `${event.visit.country}-${event.visit.regionCode || "global"}`,
        metroCode: `${event.visit.country}-${event.visit.regionCode || "global"}`,
        timezone: event.visit.timezone,
        organization: event.visit.organization,
        browser: record.browser,
        browserVersion: record.browserVersion,
        os: record.os,
        osVersion: record.osVersion,
        deviceType: record.deviceType,
        userAgent: `Mozilla/5.0 (${record.os}; ${record.deviceType}) AppleWebKit/537.36 ${record.browser}/${record.browserVersion}`,
        language: event.visit.language,
        screenWidth: Number.isFinite(screenWidth) ? screenWidth : null,
        screenHeight: Number.isFinite(screenHeight) ? screenHeight : null,
        status: "completed",
        startedAt: event.visit.startedAt,
        previousVisitId: "",
        previousVisitStartedAt: null,
        lastActivityAt: event.visit.startedAt + event.visit.durationMs,
        endedAt: event.visit.startedAt + event.visit.durationMs,
        finalizedAt: endedAt + 80,
        durationMs: event.visit.durationMs,
        durationSource: "mock",
        exitReason: "navigation",
        performance,
      },
      eventData: demoEventRecordPayload(event),
    },
  };
}
