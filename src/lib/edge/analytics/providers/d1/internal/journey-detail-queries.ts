import { SITE_PK_FROM_SITE_ID_SQL } from "@/lib/edge/site-identity-sql";
import type { Env } from "@/lib/edge/types";

import type {
  GeoPointRow,
  JourneyEventRow,
  QueryWindow,
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
  SELECT visit_source.*, 1 AS is_visit_observation
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
  SELECT visit_source.*, 1 AS is_visit_observation
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

type JourneyEventDetailKind = Exclude<JourneyEventRow["kind"], "custom">;

function nullableDetailNumber(
  row: Record<string, unknown>,
  key: string,
): number | null {
  if (row[key] === null || row[key] === undefined) return null;
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function detailBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function journeyEventDetailContext(
  event: JourneyEventRow,
  row: Record<string, unknown> = {},
  session?: SessionRow,
) {
  const text = (key: string, fallback: string): string => {
    const value = row[key];
    return value === null || value === undefined || value === ""
      ? fallback
      : String(value);
  };
  const number = (key: string, fallback: number): number => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    visitId: text("visitId", event.visitId),
    sessionId: text("sessionId", event.sessionId),
    visitorId: text("visitorId", event.visitorId),
    userId: text("userId", ""),
    userName: text("userName", ""),
    pathname: text("pathname", event.pathname),
    queryString: text("queryString", ""),
    hash: text("hash", event.hash),
    title: text("title", event.title),
    hostname: text("hostname", event.hostname),
    referrerUrl: text("referrerUrl", event.referrerUrl),
    referrerHost: text("referrerHost", event.referrerHost),
    utmSource: text("utmSource", ""),
    utmMedium: text("utmMedium", ""),
    utmCampaign: text("utmCampaign", ""),
    utmTerm: text("utmTerm", ""),
    utmContent: text("utmContent", ""),
    isEU: detailBoolean(row.isEU),
    country: text("country", event.country),
    region: text("region", event.region),
    regionCode: text("regionCode", ""),
    city: text("city", event.city),
    continent: text("continent", ""),
    latitude: nullableDetailNumber(row, "latitude"),
    longitude: nullableDetailNumber(row, "longitude"),
    postalCode: text("postalCode", ""),
    metroCode: text("metroCode", ""),
    timezone: text("timezone", ""),
    organization: text("organization", ""),
    browser: text("browser", event.browser),
    browserVersion: text("browserVersion", event.browserVersion),
    os: text("os", event.os),
    osVersion: text("osVersion", event.osVersion),
    deviceType: text("deviceType", event.deviceType),
    userAgent: text("userAgent", ""),
    language: text("language", ""),
    screenWidth: event.screenWidth,
    screenHeight: event.screenHeight,
    status: session
      ? session.active
        ? "open"
        : "complete"
      : text("status", ""),
    startedAt: session?.startedAt ?? number("startedAt", event.occurredAt),
    previousVisitId: text("previousVisitId", ""),
    previousVisitStartedAt: nullableDetailNumber(row, "previousVisitStartedAt"),
    lastActivityAt:
      session?.endedAt ?? number("lastActivityAt", event.occurredAt),
    endedAt: session?.endedAt ?? nullableDetailNumber(row, "endedAt"),
    finalizedAt: nullableDetailNumber(row, "finalizedAt"),
    durationMs: session?.durationMs ?? nullableDetailNumber(row, "durationMs"),
    durationSource: text("durationSource", ""),
    exitReason: text("exitReason", ""),
    performance: event.performance,
  };
}

function journeyEventDetailRecord(event: JourneyEventRow) {
  return {
    eventId: event.id,
    eventName: event.eventType,
    eventKind: event.kind,
    occurredAt: event.occurredAt,
    receivedAt: event.occurredAt,
    sequence: 0,
    visitId: event.visitId,
    sessionId: event.sessionId,
    visitorId: event.visitorId,
    pathname: event.pathname,
    title: event.title,
    hostname: event.hostname,
    referrerHost: event.referrerHost,
    country: event.country,
    region: event.region,
    browser: event.browser,
    browserVersion: event.browserVersion,
    os: event.os,
    osVersion: event.osVersion,
    deviceType: event.deviceType,
    nodeCount: 0,
    valueCount: 0,
  };
}

function mapJourneyPageviewDetail(row: Record<string, unknown>): {
  event: ReturnType<typeof journeyEventDetailRecord>;
  context: ReturnType<typeof journeyEventDetailContext>;
} {
  const event = mapJourneyEventRow({
    id: String(row.visitId ?? ""),
    kind: "pageview",
    eventType: "pageview",
    occurredAt: Number(row.startedAt ?? 0),
    visitId: row.visitId,
    sessionId: row.sessionId,
    visitorId: row.visitorId,
    pathname: row.pathname,
    hash: row.hash,
    title: row.title,
    hostname: row.hostname,
    referrerHost: row.referrerHost,
    referrerUrl: row.referrerUrl,
    country: row.country,
    region: row.region,
    city: row.city,
    browser: row.browser,
    browserVersion: row.browserVersion,
    os: row.os,
    osVersion: row.osVersion,
    deviceType: row.deviceType,
    screenWidth: row.screenWidth,
    screenHeight: row.screenHeight,
    durationMs: row.durationMs,
    perfTtfbMs: row.perfTtfbMs,
    perfFcpMs: row.perfFcpMs,
    perfLcpMs: row.perfLcpMs,
    perfCls: row.perfCls,
    perfInpMs: row.perfInpMs,
  });
  return {
    event: journeyEventDetailRecord(event),
    context: journeyEventDetailContext(event, row),
  };
}

/**
 * Resolve one standard JourneyEvent without touching custom event payloads.
 * Pageviews use their visit id; session boundary events use the stable ids
 * emitted by sessionStartEvent/sessionLeaveEvent.
 */
export async function queryJourneyEventDetailFromD1(
  env: Env,
  siteId: string,
  eventId: string,
  window: QueryWindow,
  eventKind?: JourneyEventDetailKind,
) {
  if (!eventKind || eventKind === "pageview") {
    const rows = await queryD1All<Record<string, unknown>>(
      env,
      `
SELECT
  v.visit_id AS visitId,
  v.session_id AS sessionId,
  v.visitor_id AS visitorId,
  COALESCE(v.user_id, '') AS userId,
  COALESCE(v.user_name, '') AS userName,
  COALESCE(
    (
      SELECT pv.visit_id
      FROM visits pv
      WHERE pv.site_pk = v.site_pk
        AND pv.session_id = v.session_id
        AND pv.started_at < v.started_at
      ORDER BY pv.started_at DESC, pv.visit_id DESC
      LIMIT 1
    ),
    ''
  ) AS previousVisitId,
  (
    SELECT pv.started_at
    FROM visits pv
    WHERE pv.site_pk = v.site_pk
      AND pv.session_id = v.session_id
      AND pv.started_at < v.started_at
    ORDER BY pv.started_at DESC, pv.visit_id DESC
    LIMIT 1
  ) AS previousVisitStartedAt,
  v.started_at AS startedAt,
  v.last_activity_at AS lastActivityAt,
  v.ended_at AS endedAt,
  v.finalized_at AS finalizedAt,
  v.duration_ms AS durationMs,
  COALESCE(v.duration_source, '') AS durationSource,
  COALESCE(v.exit_reason, '') AS exitReason,
  v.pathname,
  v.query_string AS queryString,
  v.hash_fragment AS hash,
  v.title,
  v.hostname,
  v.referrer_url AS referrerUrl,
  v.referrer_host AS referrerHost,
  v.utm_source AS utmSource,
  v.utm_medium AS utmMedium,
  v.utm_campaign AS utmCampaign,
  v.utm_term AS utmTerm,
  v.utm_content AS utmContent,
  v.is_eu AS isEU,
  v.country,
  v.region,
  v.region_code AS regionCode,
  v.city,
  v.continent,
  v.latitude,
  v.longitude,
  v.postal_code AS postalCode,
  v.metro_code AS metroCode,
  v.timezone,
  v.as_organization AS organization,
  v.browser,
  v.browser_version AS browserVersion,
  v.os,
  v.os_version AS osVersion,
  v.device_type AS deviceType,
  v.ua_raw AS userAgent,
  v.language,
  v.screen_width AS screenWidth,
  v.screen_height AS screenHeight,
  v.status,
  v.perf_ttfb_ms AS perfTtfbMs,
  v.perf_fcp_ms AS perfFcpMs,
  v.perf_lcp_ms AS perfLcpMs,
  v.perf_cls AS perfCls,
  v.perf_inp_ms AS perfInpMs
FROM visits v
WHERE v.site_pk = ${SITE_PK_FROM_SITE_ID_SQL}
  AND v.visit_id = ?
  AND v.started_at >= ?
  AND v.started_at < ?
LIMIT 1
`,
      [siteId, eventId, window.startMs, window.endExclusiveMs],
    );
    const pageview = rows[0];
    if (pageview) return mapJourneyPageviewDetail(pageview);
    if (eventKind === "pageview") return null;
  }

  const boundary = eventId.startsWith("session-start:")
    ? { kind: "session_start" as const, prefix: "session-start:" }
    : eventId.startsWith("session-leave:")
      ? { kind: "leave" as const, prefix: "session-leave:" }
      : null;
  if (!boundary || (eventKind && eventKind !== boundary.kind)) return null;
  const sessionId = eventId.slice(boundary.prefix.length);
  if (!sessionId) return null;

  const detail = await querySessionDetailFromD1(env, siteId, sessionId, window);
  const event = detail?.events.find((candidate) => candidate.id === eventId);
  if (
    !detail ||
    !event ||
    event.kind === "custom" ||
    event.occurredAt < window.startMs ||
    event.occurredAt >= window.endExclusiveMs
  ) {
    return null;
  }
  return {
    event: journeyEventDetailRecord(event),
    context: journeyEventDetailContext(event, {}, detail.session),
  };
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
  window?: QueryWindow,
): Promise<VisitorDetailSourceRow[]> {
  const sql = `
WITH
${buildTargetVisitSourceCte(detailTargetColumn(target), {
  withinWindow: Boolean(window),
})},
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
    ...targetVisitSourceBindings(siteId, target.value, window),
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
  window?: QueryWindow,
) {
  const {
    visitor,
    sessions,
    events: baseEvents,
  } = deriveVisitorDetailRows(
    await queryDetailSourceFromD1(
      env,
      siteId,
      {
        type: "visitor",
        value: visitorId,
      },
      window,
    ),
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
  window?: QueryWindow,
) {
  const sourceRows = await queryDetailSourceFromD1(
    env,
    siteId,
    {
      type: "session",
      value: sessionId,
    },
    window,
  );
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
