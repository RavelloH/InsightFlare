import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import { buildJourneyObservationPlan } from "@/lib/edge/analytics/engine/journey-observation-plan";
import { buildJourneyPageviewDetailPlan } from "@/lib/edge/analytics/engine/journey-page-report-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { currentD1Operation } from "@/lib/edge/observability/logger";
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
  queryD1CompiledAll,
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
import { queryJourneyPageReportRowsFromD1 } from "./journey-page-report-query";
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
  const rows = await queryJourneyObservationRows(
    env,
    siteId,
    target,
    "timeline",
  );
  return rows.map(mapJourneyEventRow);
}

async function queryJourneyObservationRows(
  env: Env,
  siteId: string,
  target: DetailTarget,
  shape: "timeline" | "detail-source",
  window?: QueryWindow,
): Promise<Record<string, unknown>[]> {
  const plan = buildJourneyObservationPlan({
    siteId,
    target,
    shape,
    ...(window ? { window } : {}),
  });
  const output = plan.outputs.find(
    (candidate) =>
      candidate.id ===
      (shape === "timeline"
        ? "journey-observation-timeline"
        : "journey-observation-detail-source"),
  );
  if (!output) throw new Error("journey_observation_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: currentD1Operation() ?? "analytics.query.all",
  });
  const rows = await queryD1CompiledAll<object>(env, query);
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
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
export function mapJourneyPageviewDetail(row: Record<string, unknown>): {
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
    const rows = await queryJourneyPageReportRowsFromD1(
      env,
      buildJourneyPageviewDetailPlan({ siteId, eventId, window }),
      "journey-pageview-detail",
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
function latestIdentityVisit(
  visits: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (let index = visits.length - 1; index >= 0; index -= 1) {
    const visit = visits[index]!;
    if (detailText(visit, "userId").trim() !== "") return visit;
  }
  return null;
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
  const rows = await queryJourneyObservationRows(
    env,
    siteId,
    target,
    "detail-source",
    window,
  );
  return rows.map((row) => {
    const sourceType = row.sourceType;
    if (sourceType !== "visit" && sourceType !== "custom")
      throw new Error("journey_observation_source_type_invalid");
    return { ...row, sourceType };
  });
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
  const identityVisit = latestIdentityVisit(visits);
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
    userId: identityVisit ? detailText(identityVisit, "userId") : "",
    userName: identityVisit ? detailText(identityVisit, "userName") : "",
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
      const identityVisit = latestIdentityVisit(sessionVisits);
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
        userId: identityVisit ? detailText(identityVisit, "userId") : "",
        userName: identityVisit ? detailText(identityVisit, "userName") : "",
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
export function stripVisitorDetailCollections<
  T extends {
    readonly sessions: readonly unknown[];
    readonly events: readonly unknown[];
  },
>(detail: T) {
  const { sessions: _sessions, events: _events, ...summary } = detail;
  return summary;
}
export function stripSessionDetailCollections<
  T extends { readonly events: readonly unknown[] },
>(detail: T) {
  const { events: _events, ...summary } = detail;
  return summary;
}
