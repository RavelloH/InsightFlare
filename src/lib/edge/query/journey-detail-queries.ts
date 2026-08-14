import type { Env } from "@/lib/edge/types";

import type { JourneyEventRow, SessionRow, VisitorRow } from "./core";
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
import { querySessionLocationPointsFromD1 } from "./journey-geo-queries";
import type { DetailTarget } from "./journey-helpers";
import {
  averageGapMs,
  detailTargetColumn,
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

export async function queryVisitorDetailFromD1(
  env: Env,
  siteId: string,
  visitorId: string,
  timeZone: string,
) {
  const [visitor, sessions, baseEvents] = await Promise.all([
    queryVisitorForDetailFromD1(env, siteId, visitorId),
    querySessionsForDetailFromD1(env, siteId, {
      type: "visitor",
      value: visitorId,
    }),
    queryJourneyEventsForDetailFromD1(env, siteId, {
      type: "visitor",
      value: visitorId,
    }),
  ]);
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
  const [sessions, baseEvents, locationPoints] = await Promise.all([
    querySessionsForDetailFromD1(env, siteId, {
      type: "session",
      value: sessionId,
    }),
    queryJourneyEventsForDetailFromD1(env, siteId, {
      type: "session",
      value: sessionId,
    }),
    querySessionLocationPointsFromD1(env, siteId, sessionId),
  ]);
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
