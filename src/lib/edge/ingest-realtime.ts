import {
  ACTIVE_NOW_WINDOW_MS,
  RECENT_EVENT_QUERY_SCAN_LIMIT,
  RECENT_EVENT_RETENTION_MS,
  WS_PRESENCE_LEAVE_EVENT,
} from "./ingest-constants";
import {
  type RealtimeSnapshotRecord,
  toRealtimePayload,
  toRealtimeVisitPayload,
} from "./ingest-normalize";
import type { SqlBinding } from "./ingest-sql";
import type { SqlReader, VisitRow } from "./ingest-types";

interface RealtimeContext extends SqlReader {
  sockets: Set<WebSocket>;
}

export function snapshotQueryParams(url: URL): {
  fromMs: number;
  toMs: number;
  limit: number;
} {
  const fromMsRaw = Number(url.searchParams.get("from") || "0");
  const toMsRaw = Number(url.searchParams.get("to") || String(Date.now()));
  const limitRaw = Number(url.searchParams.get("limit") || "5000");

  const fromMs = Number.isFinite(fromMsRaw)
    ? Math.max(0, Math.floor(fromMsRaw))
    : 0;
  const toMs = Number.isFinite(toMsRaw)
    ? Math.max(fromMs, Math.floor(toMsRaw))
    : Date.now();
  const limit = Number.isFinite(limitRaw)
    ? Math.min(RECENT_EVENT_QUERY_SCAN_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : 5000;

  return { fromMs, toMs, limit };
}

export function readRecentRealtimeEvents(
  context: Pick<SqlReader, "sqlAll">,
  fromMs: number,
  toMs: number,
  limit?: number,
): Array<Record<string, unknown>> {
  const limitClause =
    typeof limit === "number" ? "\n        LIMIT ?\n      " : "";
  const bindings: SqlBinding[] = [fromMs, toMs, fromMs, toMs, fromMs, toMs];
  if (typeof limit === "number") {
    bindings.push(limit);
  }

  const rows = context.sqlAll<RealtimeSnapshotRecord>(
    `
      SELECT
        id,
        eventType,
        eventAt,
        visitId,
        sessionId,
        pathname,
        hash,
        title,
        hostname,
        referrerUrl,
        referrerHost,
        visitorId,
        country,
        region,
        regionCode,
        city,
        continent,
        timezone,
        organization,
        browser,
        os,
        osVersion,
        deviceType,
        language,
        user_id, user_name,
        screenSize,
        latitude,
        longitude
      FROM (
        SELECT
          visit_id AS id,
          'visit' AS eventType,
          started_at AS eventAt,
          visit_id AS visitId,
          session_id AS sessionId,
          pathname,
          hash_fragment AS hash,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          visitor_id AS visitorId,
          country,
          region,
          region_code AS regionCode,
          city,
          continent,
          timezone,
          as_organization AS organization,
          browser,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          language,
          user_id, user_name,
          CASE
            WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL
              THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
            ELSE ''
          END AS screenSize,
          latitude,
          longitude
        FROM buffered_visits
        WHERE started_at BETWEEN ? AND ?
        UNION ALL
        SELECT
          event_id AS id,
          event_name AS eventType,
          occurred_at AS eventAt,
          COALESCE(v.visit_id, '') AS visitId,
          COALESCE(v.session_id, '') AS sessionId,
          COALESCE(v.pathname, '') AS pathname,
          COALESCE(v.hash_fragment, '') AS hash,
          COALESCE(v.title, '') AS title,
          COALESCE(v.hostname, '') AS hostname,
          COALESCE(v.referrer_url, '') AS referrerUrl,
          COALESCE(v.referrer_host, '') AS referrerHost,
          COALESCE(v.visitor_id, '') AS visitorId,
          COALESCE(v.country, '') AS country,
          COALESCE(v.region, '') AS region,
          COALESCE(v.region_code, '') AS regionCode,
          COALESCE(v.city, '') AS city,
          COALESCE(v.continent, '') AS continent,
          COALESCE(v.timezone, '') AS timezone,
          COALESCE(v.as_organization, '') AS organization,
          COALESCE(v.browser, '') AS browser,
          COALESCE(v.os, '') AS os,
          COALESCE(v.os_version, '') AS osVersion,
          COALESCE(v.device_type, '') AS deviceType,
          COALESCE(v.language, '') AS language,
          COALESCE(NULLIF(e.user_id, ''), v.user_id, '') AS user_id,
          COALESCE(v.user_name, '') AS user_name,
          CASE
            WHEN v.screen_width IS NOT NULL AND v.screen_height IS NOT NULL
              THEN CAST(v.screen_width AS TEXT) || 'x' || CAST(v.screen_height AS TEXT)
            ELSE ''
          END AS screenSize,
          v.latitude AS latitude,
          v.longitude AS longitude
        FROM buffered_custom_events e
        LEFT JOIN buffered_visits v
          ON v.site_id = e.site_id
         AND v.visit_id = e.visit_id
        WHERE e.occurred_at BETWEEN ? AND ?
        UNION ALL
        SELECT
          'leave:' || visit_id AS id,
          '${WS_PRESENCE_LEAVE_EVENT}' AS eventType,
          ended_at AS eventAt,
          visit_id AS visitId,
          session_id AS sessionId,
          pathname,
          hash_fragment AS hash,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          visitor_id AS visitorId,
          country,
          region,
          region_code AS regionCode,
          city,
          continent,
          timezone,
          as_organization AS organization,
          browser,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          language,
          user_id, user_name,
          CASE
            WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL
              THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
            ELSE ''
          END AS screenSize,
          latitude,
          longitude
        FROM buffered_visits
        WHERE status NOT IN ('open', 'hidden_pending')
          AND ended_at IS NOT NULL
          AND ended_at BETWEEN ? AND ?
      )
      ORDER BY eventAt DESC
             , CASE
                 WHEN eventType = '${WS_PRESENCE_LEAVE_EVENT}' THEN 0
                 ELSE 1
               END DESC${limitClause}
    `,
    ...bindings,
  );
  return rows.map((row) => toRealtimePayload(row));
}

export function readActiveRealtimeVisits(
  context: Pick<SqlReader, "sqlAll">,
  cutoffMs: number,
): Array<Record<string, unknown>> {
  const rows = context.sqlAll<
    VisitRow & {
      lastActivityAt: number;
    }
  >(
    `
      SELECT
        visit_id AS visitId,
        status,
        site_id AS siteId,
        visitor_id AS visitorId,
        session_id AS sessionId,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        pathname,
        query_string AS queryString,
        hash_fragment AS hashFragment,
        hostname,
        title,
        referrer_url AS referrerUrl,
        referrer_host AS referrerHost,
        utm_source AS utmSource,
        utm_medium AS utmMedium,
        utm_campaign AS utmCampaign,
        utm_term AS utmTerm,
        utm_content AS utmContent,
        is_eu AS isEU,
        country,
        region,
        region_code AS regionCode,
        city,
        continent,
        latitude,
        longitude,
        postal_code AS postalCode,
        metro_code AS metroCode,
        timezone,
        as_organization AS asOrganization,
        ua_raw AS uaRaw,
        browser,
        browser_version AS browserVersion,
        os,
        os_version AS osVersion,
        device_type AS deviceType,
        screen_width AS screenWidth,
        screen_height AS screenHeight,
        language
      FROM buffered_visits
      WHERE status = 'open'
        AND last_activity_at >= ?
      ORDER BY last_activity_at DESC, started_at DESC
    `,
    cutoffMs,
  );

  return rows.map((row) => toRealtimeVisitPayload(row));
}

export async function pushInitialRealtimeSnapshot(
  context: RealtimeContext,
  socket: WebSocket,
): Promise<boolean> {
  try {
    const cutoffMs = Date.now() - ACTIVE_NOW_WINDOW_MS;
    const events = readRecentRealtimeEvents(
      context,
      Math.max(0, Date.now() - RECENT_EVENT_RETENTION_MS),
      Date.now(),
    );
    const activeNow =
      context.sqlOne<{ count: number }>(
        `
        SELECT count(DISTINCT visitor_id) AS count
        FROM buffered_visits
        WHERE status = 'open'
          AND last_activity_at >= ?
      `,
        cutoffMs,
      )?.count ?? 0;
    const visits = readActiveRealtimeVisits(context, cutoffMs);

    socket.send(
      JSON.stringify({
        type: "snapshot",
        data: {
          activeNow,
          events,
          visits,
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function pushRealtimeRecordToSockets(
  sockets: Set<WebSocket>,
  record: RealtimeSnapshotRecord,
): Promise<void> {
  if (sockets.size === 0) {
    return;
  }

  const payload = JSON.stringify({
    type: "event",
    data: toRealtimePayload(record),
  });
  const staleSockets: WebSocket[] = [];
  let sent = 0;

  for (const socket of sockets) {
    try {
      socket.send(payload);
      sent += 1;
    } catch {
      staleSockets.push(socket);
    }
  }

  for (const socket of staleSockets) {
    sockets.delete(socket);
    try {
      socket.close();
    } catch {
      // no-op
    }
  }
  void sent;
}
