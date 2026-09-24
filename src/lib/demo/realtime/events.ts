import "@/lib/analytics/time-zone";
import "@/lib/browser-engine";
import "@/lib/demo/admin/durable-objects";
import "@/lib/demo/admin/system-performance";
import "@/lib/demo/admin/users";
import "@/lib/demo/data/site-profiles";
import "@/lib/demo/generators/utils";
import "@/lib/demo/realtime/dimension-pickers";
import "@/lib/demo/realtime/dimension-pools";
import "@/lib/demo/realtime/path-markov";
import "@/lib/demo/realtime/site-curves";
import "@/lib/demo/realtime/visit-helpers";
import "@/lib/demo/realtime/visitor-pool";

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
} from "@/lib/demo/realtime/events-helpers";
import {
  applyDemoFilters,
  buildDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import {
  demoValuesIncludeSearch,
  normalizeDemoFilterValue,
  normalizeDemoSearch,
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import { demoPage } from "@/lib/demo/realtime/pagination";
import {
  buildDemoTimeBuckets,
  createDemoShareTrendSeriesKey,
  DEMO_SHARE_TREND_OTHER_KEY,
  DEMO_SHARE_TREND_OTHER_LABEL,
  findDemoTimeBucketIndex,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
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
    { allVisits: dataset.visits },
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
  const limit = parseDemoLimit(params.limit, 8, 1, 18);
  const filters = parseDemoFilters(params);
  const eventName = normalizeDemoFilterValue(params.eventName);
  const timeZone = parseDemoTimeZone(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const allEvents = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
    { allVisits: dataset.visits },
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
    data: {
      interval,
      series,
      data,
    },
  };
}
export function generateDemoEventsRecords(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const eventName = normalizeDemoFilterValue(params.eventName);
  const search = normalizeDemoSearch(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
    { allVisits: dataset.visits },
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
  const page = demoPage(
    sorted.map(demoEventRecordFromFact),
    params,
    {
      operation: "events-records",
      siteId,
      from,
      to,
      filters,
      eventName,
      search,
      sort: parseDemoEventRecordSort(params),
    },
    80,
    1_000,
    false,
  );

  return {
    ok: true,
    data: page,
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
    { allVisits: dataset.visits },
  );
  const events = allEvents.filter((event) => event.eventName === eventName);
  const sessions = new Set(events.map((event) => event.visit.sessionId));
  const visitors = new Set(events.map((event) => event.visit.visitorId));
  const includeContext =
    params.includeContext === undefined ||
    parseDemoBoolean(params.includeContext);
  const includeBreakdowns =
    params.includeBreakdowns === undefined ||
    parseDemoBoolean(params.includeBreakdowns);
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
    breakdowns: includeBreakdowns
      ? {
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
        }
      : { pages: [], countries: [], devices: [], browsers: [] },
    cards: includeContext
      ? demoEventContextCards(dataset, events, 100)
      : demoEventContextCards(dataset, [], 0),
  };
}
export function generateDemoEventTypeContext(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
    { allVisits: dataset.visits },
  ).filter((event) => event.eventName === eventName);

  const cards = demoEventContextCards(dataset, events, 100);
  if (params.cards !== undefined) {
    const selected = new Set(
      String(params.cards)
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    );
    const cardGroups: Array<[string, string, string]> = [
      ["page", "path", "path"],
      ["page", "query", "query"],
      ["page", "title", "title"],
      ["page", "hostname", "hostname"],
      ["page", "entry", "entry"],
      ["page", "exit", "exit"],
      ["source", "domain", "sourceDomain"],
      ["source", "link", "sourceLink"],
      ["client", "browser", "browser"],
      ["client", "osVersion", "osVersion"],
      ["client", "deviceType", "deviceType"],
      ["client", "language", "language"],
      ["client", "screenSize", "screenSize"],
      ["geo", "country", "country"],
      ["geo", "region", "region"],
      ["geo", "city", "city"],
      ["geo", "continent", "continent"],
      ["geo", "timezone", "timezone"],
      ["geo", "organization", "organization"],
    ];
    for (const [group, key, selectedKey] of cardGroups) {
      if (!selected.has(selectedKey)) {
        (cards[group as keyof typeof cards] as Record<string, unknown>)[key] =
          [];
      }
    }
  }

  return {
    ok: true,
    eventName,
    cards,
  };
}
export function generateDemoEventFields(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const eventName = normalizeDemoFilterValue(params.eventName) ?? "";

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
    { allVisits: dataset.visits },
  ).filter((event) => !eventName || event.eventName === eventName);
  const binding = {
    operation: "event-fields",
    siteId,
    from,
    to,
    filters,
    eventName,
    sort: "events:desc,occurrences:desc,path:asc,valueType:asc",
  };

  return {
    ok: true,
    eventName,
    data: demoPage(
      collectDemoEventFields(events, Math.max(1, events.length)),
      params,
      binding,
      100,
      200,
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
  const search = normalizeDemoSearch(params);
  const binding = {
    operation: "event-field-values",
    siteId,
    from,
    to,
    filters,
    eventName,
    fieldPath,
    fieldValueType,
    search,
    sort: "occurrences:desc,events:desc,value:asc",
  };
  if (!fieldPath || !fieldValueType) {
    return {
      ok: true,
      fieldPath,
      fieldValueType,
      data: demoPage([], params, binding, 25, 100),
    };
  }
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const events = filterDemoCustomEventsByPayload(
    createDemoCustomEventFacts(filtered.visits),
    filters,
    { allVisits: dataset.visits },
  ).filter((event) => !eventName || event.eventName === eventName);

  const rows = collectDemoEventFieldValues(
    events,
    fieldPath,
    fieldValueType,
    Math.max(1, events.length),
  ).filter((row) => demoValuesIncludeSearch(search, [row.value]));
  return {
    ok: true,
    fieldPath,
    fieldValueType,
    data: demoPage(rows, params, binding, 25, 100),
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
  const event = createDemoCustomEventFacts(dataset.visits).find(
    (item) => item.eventId === eventId,
  );
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
        userId: event.visit.userId ?? "",
        userName: event.visit.userName ?? "",
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
