import type { Env } from "@/lib/edge/types";

import type {
  GeoPointRow,
  JourneyEventRow,
  SessionRow,
  VisitorRow,
} from "./core";
import {
  buildDetailCustomEventSourceCte,
  buildTargetVisitSourceCte,
  detailCustomEventSourceBindings,
  queryD1All,
  targetVisitSourceBindings,
} from "./core";
import {
  buildSessionAggregationSql,
  buildVisitorAggregationSql,
} from "./journey-aggregation-sql";
import type { DetailTarget } from "./journey-helpers";
import {
  averageGapMs,
  detailTargetColumn,
  mapGeoPointRow,
  mapJourneyEventRow,
  mapSessionRow,
  mapVisitorRow,
  percentile,
  reportingDateKey,
  sessionLeaveEvent,
  sessionStartEvent,
  summarizeActivity,
  summarizeEventDistribution,
  summarizeJourneyPerformance,
  summarizeVisitedPages,
} from "./journey-helpers";

export async function queryVisitorForDetailFromD1(
  env: Env,
  siteId: string,
  visitorId: string,
): Promise<VisitorRow | null> {
  const sql = `
WITH
${buildTargetVisitSourceCte("visitor_id")},
filtered_visits AS (
  SELECT *
  FROM visit_source
),
${buildDetailCustomEventSourceCte()},
${buildVisitorAggregationSql({ orderBy: "lastSeenAt DESC, visitorId ASC", limitOffset: "LIMIT 1" })}`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...targetVisitSourceBindings(siteId, visitorId),
    ...detailCustomEventSourceBindings(siteId),
  ]);
  return rows[0] ? mapVisitorRow(rows[0]) : null;
}

export async function querySessionsForDetailFromD1(
  env: Env,
  siteId: string,
  target: DetailTarget,
): Promise<SessionRow[]> {
  const sql = `
WITH
${buildTargetVisitSourceCte(detailTargetColumn(target))},
filtered_visits AS (
  SELECT *
  FROM visit_source
),
${buildDetailCustomEventSourceCte()},
${buildSessionAggregationSql({ orderBy: "startedAt DESC, sessionId ASC" })}`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...targetVisitSourceBindings(siteId, target.value),
      ...detailCustomEventSourceBindings(siteId),
    ])
  ).map(mapSessionRow);
}

export async function queryJourneyEventsForDetailFromD1(
  env: Env,
  siteId: string,
  target: DetailTarget,
): Promise<JourneyEventRow[]> {
  const sql = `
WITH
${buildTargetVisitSourceCte(detailTargetColumn(target))},
filtered_visits AS (
  SELECT *
  FROM visit_source
),
${buildDetailCustomEventSourceCte()},
page_events AS (
  SELECT
    visit_id AS id,
    'pageview' AS kind,
    'pageview' AS eventType,
    started_at AS occurredAt,
    visit_id AS visitId,
    session_id AS sessionId,
    visitor_id AS visitorId,
    pathname,
    hash_fragment AS hash,
    title,
    hostname,
    referrer_host AS referrerHost,
    referrer_url AS referrerUrl,
    country,
    region,
    city,
    browser,
    browser_version AS browserVersion,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    screen_width AS screenWidth,
    screen_height AS screenHeight,
    COALESCE(duration_ms, 0) AS durationMs,
    perf_ttfb_ms AS perfTtfbMs,
    perf_fcp_ms AS perfFcpMs,
    perf_lcp_ms AS perfLcpMs,
    perf_cls AS perfCls,
    perf_inp_ms AS perfInpMs
  FROM filtered_visits
),
custom_event_rows AS (
  SELECT
    event_id AS id,
    'custom' AS kind,
    event_name AS eventType,
    occurred_at AS occurredAt,
    visit_id AS visitId,
    session_id AS sessionId,
    visitor_id AS visitorId,
    pathname,
    hash_fragment AS hash,
    title,
    hostname,
    referrer_host AS referrerHost,
    referrer_url AS referrerUrl,
    country,
    region,
    city,
    browser,
    browser_version AS browserVersion,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    screen_width AS screenWidth,
    screen_height AS screenHeight,
    0 AS durationMs,
    perf_ttfb_ms AS perfTtfbMs,
    perf_fcp_ms AS perfFcpMs,
    perf_lcp_ms AS perfLcpMs,
    perf_cls AS perfCls,
    perf_inp_ms AS perfInpMs
  FROM event_source
)
SELECT *
FROM (
  SELECT * FROM page_events
  UNION ALL
  SELECT * FROM custom_event_rows
)
ORDER BY occurredAt DESC, id DESC
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...targetVisitSourceBindings(siteId, target.value),
      ...detailCustomEventSourceBindings(siteId),
    ])
  ).map(mapJourneyEventRow);
}

type VisitorDetailSourceRow = Record<string, unknown> & {
  sourceType: "visit" | "custom";
};

function detailNumber(row: Record<string, unknown>, key: string): number {
  return Number(row[key] ?? 0);
}

function detailText(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? "");
}

function compareDetailVisits(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return (
    detailNumber(left, "startedAt") - detailNumber(right, "startedAt") ||
    detailText(left, "visitId").localeCompare(detailText(right, "visitId"))
  );
}

async function queryDetailSourceFromD1(
  env: Env,
  siteId: string,
  target: DetailTarget,
): Promise<VisitorDetailSourceRow[]> {
  const sql = `
WITH
${buildTargetVisitSourceCte(detailTargetColumn(target))},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
),
${buildDetailCustomEventSourceCte({ materialize: true })}
SELECT
  'visit' AS sourceType,
  visit_id AS visitId,
  visitor_id AS visitorId,
  session_id AS sessionId,
  status,
  started_at AS startedAt,
  last_activity_at AS lastActivityAt,
  ended_at AS endedAt,
  duration_ms AS durationMs,
  pathname,
  hash_fragment AS hash,
  title,
  hostname,
  referrer_host AS referrerHost,
  referrer_url AS referrerUrl,
  country,
  region,
  region_code AS regionCode,
  city,
  latitude,
  longitude,
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  screen_width AS screenWidth,
  screen_height AS screenHeight,
  perf_ttfb_ms AS perfTtfbMs,
  perf_fcp_ms AS perfFcpMs,
  perf_lcp_ms AS perfLcpMs,
  perf_cls AS perfCls,
  perf_inp_ms AS perfInpMs,
  NULL AS eventId,
  NULL AS eventType,
  NULL AS occurredAt
FROM filtered_visits
UNION ALL
SELECT
  'custom' AS sourceType,
  visit_id AS visitId,
  visitor_id AS visitorId,
  session_id AS sessionId,
  NULL AS status,
  NULL AS startedAt,
  NULL AS lastActivityAt,
  NULL AS endedAt,
  NULL AS durationMs,
  pathname,
  hash_fragment AS hash,
  title,
  hostname,
  referrer_host AS referrerHost,
  referrer_url AS referrerUrl,
  country,
  region,
  NULL AS regionCode,
  city,
  NULL AS latitude,
  NULL AS longitude,
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  screen_width AS screenWidth,
  screen_height AS screenHeight,
  perf_ttfb_ms AS perfTtfbMs,
  perf_fcp_ms AS perfFcpMs,
  perf_lcp_ms AS perfLcpMs,
  perf_cls AS perfCls,
  perf_inp_ms AS perfInpMs,
  event_id AS eventId,
  event_name AS eventType,
  occurred_at AS occurredAt
FROM event_source
`;
  return queryD1All<VisitorDetailSourceRow>(env, sql, [
    ...targetVisitSourceBindings(siteId, target.value),
    ...detailCustomEventSourceBindings(siteId),
  ]);
}

function deriveVisitorDetailRows(rows: VisitorDetailSourceRow[]): {
  visitor: VisitorRow | null;
  sessions: SessionRow[];
  events: JourneyEventRow[];
} {
  const visits = rows.filter((row) => row.sourceType === "visit");
  if (visits.length === 0) return { visitor: null, sessions: [], events: [] };

  visits.sort(compareDetailVisits);
  const customEvents = rows.filter((row) => row.sourceType === "custom");
  const firstVisit = visits[0]!;
  const latestVisit = visits.at(-1)!;
  const sessionsById = new Map<string, Record<string, unknown>[]>();
  const eventCountBySession = new Map<string, number>();

  for (const event of customEvents) {
    const sessionId = detailText(event, "sessionId");
    if (!sessionId) continue;
    eventCountBySession.set(
      sessionId,
      (eventCountBySession.get(sessionId) ?? 0) + 1,
    );
  }
  for (const visit of visits) {
    const sessionId = detailText(visit, "sessionId");
    if (!sessionId) continue;
    const sessionVisits = sessionsById.get(sessionId) ?? [];
    sessionVisits.push(visit);
    sessionsById.set(sessionId, sessionVisits);
  }

  const visitor = mapVisitorRow({
    visitorId: detailText(firstVisit, "visitorId"),
    sessionId: detailText(latestVisit, "sessionId"),
    firstSeenAt: detailNumber(firstVisit, "startedAt"),
    lastSeenAt: detailNumber(latestVisit, "startedAt"),
    views: visits.length,
    sessions: sessionsById.size,
    events: customEvents.length,
    country: detailText(latestVisit, "country"),
    region: detailText(latestVisit, "region"),
    regionCode: detailText(latestVisit, "regionCode"),
    city: detailText(latestVisit, "city"),
    referrerHost: detailText(firstVisit, "referrerHost"),
    referrerUrl: detailText(firstVisit, "referrerUrl"),
    browser: detailText(latestVisit, "browser"),
    browserVersion: detailText(latestVisit, "browserVersion"),
    os: detailText(latestVisit, "os"),
    osVersion: detailText(latestVisit, "osVersion"),
    deviceType: detailText(latestVisit, "deviceType"),
    screenWidth: latestVisit.screenWidth,
    screenHeight: latestVisit.screenHeight,
  });
  const sessions = [...sessionsById.entries()]
    .map(([sessionId, sessionVisits]) => {
      sessionVisits.sort(compareDetailVisits);
      const first = sessionVisits[0]!;
      const latest = sessionVisits.at(-1)!;
      const firstGeo = sessionVisits.find((visit) => {
        const latitude = Number(visit.latitude);
        const longitude = Number(visit.longitude);
        return (
          Number.isFinite(latitude) &&
          Number.isFinite(longitude) &&
          Math.abs(latitude) <= 90 &&
          Math.abs(longitude) <= 180
        );
      });
      return mapSessionRow({
        sessionId,
        visitorId: detailText(first, "visitorId"),
        startedAt: detailNumber(first, "startedAt"),
        endedAt: Math.max(
          ...sessionVisits.map((visit) =>
            Number(
              visit.endedAt ?? visit.lastActivityAt ?? visit.startedAt ?? 0,
            ),
          ),
        ),
        totalDurationMs: sessionVisits.reduce(
          (total, visit) => total + detailNumber(visit, "durationMs"),
          0,
        ),
        active: sessionVisits.some(
          (visit) => detailText(visit, "status").toLowerCase() === "open",
        )
          ? 1
          : 0,
        views: sessionVisits.length,
        events: eventCountBySession.get(sessionId) ?? 0,
        bounce: sessionVisits.length <= 1 ? 1 : 0,
        entryPath: detailText(first, "pathname"),
        exitPath: detailText(latest, "pathname"),
        referrerHost: detailText(first, "referrerHost"),
        referrerUrl: detailText(first, "referrerUrl"),
        country: detailText(first, "country"),
        region: detailText(first, "region"),
        regionCode: detailText(first, "regionCode"),
        city: detailText(first, "city"),
        latitude: firstGeo?.latitude ?? null,
        longitude: firstGeo?.longitude ?? null,
        browser: detailText(first, "browser"),
        browserVersion: detailText(first, "browserVersion"),
        os: detailText(first, "os"),
        osVersion: detailText(first, "osVersion"),
        deviceType: detailText(first, "deviceType"),
        screenWidth: first.screenWidth,
        screenHeight: first.screenHeight,
      });
    })
    .sort(
      (left, right) =>
        right.startedAt - left.startedAt ||
        left.sessionId.localeCompare(right.sessionId),
    );
  const events = [
    ...visits.map((visit) =>
      mapJourneyEventRow({
        id: detailText(visit, "visitId"),
        kind: "pageview",
        eventType: "pageview",
        occurredAt: detailNumber(visit, "startedAt"),
        visitId: detailText(visit, "visitId"),
        sessionId: detailText(visit, "sessionId"),
        visitorId: detailText(visit, "visitorId"),
        pathname: detailText(visit, "pathname"),
        hash: detailText(visit, "hash"),
        title: detailText(visit, "title"),
        hostname: detailText(visit, "hostname"),
        referrerHost: detailText(visit, "referrerHost"),
        referrerUrl: detailText(visit, "referrerUrl"),
        country: detailText(visit, "country"),
        region: detailText(visit, "region"),
        city: detailText(visit, "city"),
        browser: detailText(visit, "browser"),
        browserVersion: detailText(visit, "browserVersion"),
        os: detailText(visit, "os"),
        osVersion: detailText(visit, "osVersion"),
        deviceType: detailText(visit, "deviceType"),
        screenWidth: visit.screenWidth,
        screenHeight: visit.screenHeight,
        durationMs: detailNumber(visit, "durationMs"),
        perfTtfbMs: visit.perfTtfbMs,
        perfFcpMs: visit.perfFcpMs,
        perfLcpMs: visit.perfLcpMs,
        perfCls: visit.perfCls,
        perfInpMs: visit.perfInpMs,
      }),
    ),
    ...customEvents.map((event) =>
      mapJourneyEventRow({
        id: detailText(event, "eventId"),
        kind: "custom",
        eventType: detailText(event, "eventType"),
        occurredAt: detailNumber(event, "occurredAt"),
        visitId: detailText(event, "visitId"),
        sessionId: detailText(event, "sessionId"),
        visitorId: detailText(event, "visitorId"),
        pathname: detailText(event, "pathname"),
        hash: detailText(event, "hash"),
        title: detailText(event, "title"),
        hostname: detailText(event, "hostname"),
        referrerHost: detailText(event, "referrerHost"),
        referrerUrl: detailText(event, "referrerUrl"),
        country: detailText(event, "country"),
        region: detailText(event, "region"),
        city: detailText(event, "city"),
        browser: detailText(event, "browser"),
        browserVersion: detailText(event, "browserVersion"),
        os: detailText(event, "os"),
        osVersion: detailText(event, "osVersion"),
        deviceType: detailText(event, "deviceType"),
        screenWidth: event.screenWidth,
        screenHeight: event.screenHeight,
        durationMs: 0,
        perfTtfbMs: event.perfTtfbMs,
        perfFcpMs: event.perfFcpMs,
        perfLcpMs: event.perfLcpMs,
        perfCls: event.perfCls,
        perfInpMs: event.perfInpMs,
      }),
    ),
  ];
  return { visitor, sessions, events };
}

function deriveSessionLocationPoints(
  rows: VisitorDetailSourceRow[],
): GeoPointRow[] {
  return rows
    .filter(
      (row) =>
        row.sourceType === "visit" &&
        Number.isFinite(Number(row.latitude)) &&
        Number.isFinite(Number(row.longitude)) &&
        Math.abs(Number(row.latitude)) <= 90 &&
        Math.abs(Number(row.longitude)) <= 180,
    )
    .sort(compareDetailVisits)
    .map((row) =>
      mapGeoPointRow({
        latitude: row.latitude,
        longitude: row.longitude,
        timestampMs: row.startedAt,
        country: row.country,
        region: row.region,
        regionCode: row.regionCode,
        city: row.city,
      }),
    );
}

export async function queryVisitorDetailFromD1(
  env: Env,
  siteId: string,
  visitorId: string,
  timeZone: string,
) {
  const {
    visitor,
    sessions,
    events: baseEvents,
  } = deriveVisitorDetailRows(
    await queryDetailSourceFromD1(env, siteId, {
      type: "visitor",
      value: visitorId,
    }),
  );
  if (!visitor) return null;

  const events = [...sessions.map(sessionStartEvent), ...baseEvents].sort(
    (left, right) =>
      right.occurredAt - left.occurredAt || right.id.localeCompare(left.id),
  );
  const customEventCount = baseEvents.filter(
    (event) => event.kind === "custom",
  ).length;
  const sessionCount = sessions.length;
  const views = baseEvents.filter((event) => event.kind === "pageview").length;
  const bounces = sessions.filter((session) => session.bounce).length;
  const durationValues = sessions.map((session) => session.durationMs);
  const durationTotal = durationValues.reduce((sum, value) => sum + value, 0);
  const daysActive = new Set(
    events
      .filter((event) => event.occurredAt > 0)
      .map((event) => reportingDateKey(event.occurredAt, timeZone)),
  ).size;

  return {
    visitor,
    metrics: {
      totalEvents: customEventCount,
      sessions: sessionCount,
      views,
      avgEventsPerSession:
        sessionCount > 0 ? customEventCount / sessionCount : 0,
      bounceRate: sessionCount > 0 ? bounces / sessionCount : 0,
      avgDurationMs:
        sessionCount > 0 ? Math.round(durationTotal / sessionCount) : 0,
      p90DurationMs: percentile(durationValues, 90),
      firstSeenAt: visitor.firstSeenAt,
      lastSeenAt: visitor.lastSeenAt,
      daysActive,
      conversionEvents: customEventCount,
      avgTimeBetweenSessionsMs: averageGapMs(
        sessions.map((session) => session.startedAt),
      ),
    },
    sessions,
    events,
    visitedPages: summarizeVisitedPages(events),
    eventDistribution: summarizeEventDistribution(events),
    activity: summarizeActivity(events, timeZone),
    performance: summarizeJourneyPerformance(events),
  };
}

export async function querySessionDetailFromD1(
  env: Env,
  siteId: string,
  sessionId: string,
) {
  const sourceRows = await queryDetailSourceFromD1(env, siteId, {
    type: "session",
    value: sessionId,
  });
  const { sessions, events: baseEvents } = deriveVisitorDetailRows(sourceRows);
  const locationPoints = deriveSessionLocationPoints(sourceRows);
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) return null;

  const events = [
    sessionStartEvent(session),
    ...baseEvents,
    sessionLeaveEvent(session, baseEvents),
  ]
    .filter((event): event is JourneyEventRow => event !== null)
    .sort(
      (left, right) =>
        right.occurredAt - left.occurredAt || right.id.localeCompare(left.id),
    );

  return {
    session,
    locationPoints,
    events,
    visitedPages: summarizeVisitedPages(events),
    eventDistribution: summarizeEventDistribution(events),
    performance: summarizeJourneyPerformance(events),
  };
}
