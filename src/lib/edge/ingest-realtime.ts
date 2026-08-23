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
        eventKind,
        eventAt,
        siteId,
        traceId,
        receivedAt,
        sequence,
        eventName,
        eventDataJson,
        visitId,
        sessionId,
        startedAt,
        previousVisitId,
        previousVisitStartedAt,
        pathname,
        queryString,
        hash,
        title,
        hostname,
        referrerUrl,
        referrerHost,
        utmSource,
        utmMedium,
        utmCampaign,
        utmTerm,
        utmContent,
        visitorId,
        userId,
        userName,
        isEU,
        country,
        region,
        regionCode,
        city,
        continent,
        postalCode,
        metroCode,
        timezone,
        organization,
        uaRaw,
        browser,
        browserVersion,
        os,
        osVersion,
        deviceType,
        screenWidth,
        screenHeight,
        language,
        status,
        hiddenAt,
        endedAt,
        finalizedAt,
        durationMs,
        durationSource,
        exitReason,
        leaveAt,
        performanceVisitId,
        performance,
        visibilityState,
        latitude,
        longitude
      FROM (
        SELECT
          visit_id AS id,
          'visit' AS eventType,
          'pageview' AS eventKind,
          started_at AS eventAt,
          site_id AS siteId,
          '' AS traceId,
          NULL AS receivedAt,
          NULL AS sequence,
          '' AS eventName,
          NULL AS eventDataJson,
          visit_id AS visitId,
          session_id AS sessionId,
          started_at AS startedAt,
          COALESCE(
            (
              SELECT previous.visit_id
              FROM buffered_visits previous
              WHERE previous.site_id = v.site_id
                AND previous.session_id = v.session_id
                AND previous.started_at < v.started_at
              ORDER BY previous.started_at DESC, previous.visit_id DESC
              LIMIT 1
            ),
            ''
          ) AS previousVisitId,
          (
            SELECT previous.started_at
            FROM buffered_visits previous
            WHERE previous.site_id = v.site_id
              AND previous.session_id = v.session_id
              AND previous.started_at < v.started_at
            ORDER BY previous.started_at DESC, previous.visit_id DESC
            LIMIT 1
          ) AS previousVisitStartedAt,
          pathname,
          query_string AS queryString,
          hash_fragment AS hash,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          utm_source AS utmSource,
          utm_medium AS utmMedium,
          utm_campaign AS utmCampaign,
          utm_term AS utmTerm,
          utm_content AS utmContent,
          visitor_id AS visitorId,
          user_id AS userId,
          user_name AS userName,
          is_eu AS isEU,
          country,
          region,
          region_code AS regionCode,
          city,
          continent,
          postal_code AS postalCode,
          metro_code AS metroCode,
          timezone,
          as_organization AS organization,
          ua_raw AS uaRaw,
          browser,
          browser_version AS browserVersion,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          screen_width AS screenWidth,
          screen_height AS screenHeight,
          language,
          status,
          hidden_at AS hiddenAt,
          ended_at AS endedAt,
          finalized_at AS finalizedAt,
          duration_ms AS durationMs,
          duration_source AS durationSource,
          exit_reason AS exitReason,
          ended_at AS leaveAt,
          '' AS performanceVisitId,
          CASE
            WHEN perf_ttfb_ms IS NULL AND perf_fcp_ms IS NULL
              AND perf_lcp_ms IS NULL AND perf_cls IS NULL AND perf_inp_ms IS NULL
              THEN NULL
            ELSE json_object(
              'ttfb', perf_ttfb_ms,
              'fcp', perf_fcp_ms,
              'lcp', perf_lcp_ms,
              'cls', perf_cls,
              'inp', perf_inp_ms
            )
          END AS performance,
          CASE
            WHEN status = 'hidden_pending' THEN 'hidden'
            WHEN status = 'open' THEN 'visible'
            ELSE ''
          END AS visibilityState,
          latitude,
          longitude
        FROM buffered_visits v
        WHERE started_at BETWEEN ? AND ?
        UNION ALL
        SELECT
          event_id AS id,
          event_name AS eventType,
          'custom_event' AS eventKind,
          occurred_at AS eventAt,
          e.site_id AS siteId,
          '' AS traceId,
          e.received_at AS receivedAt,
          e.sequence AS sequence,
          e.event_name AS eventName,
          e.event_data_json AS eventDataJson,
          COALESCE(v.visit_id, '') AS visitId,
          COALESCE(v.session_id, '') AS sessionId,
          v.started_at AS startedAt,
          COALESCE(
            (
              SELECT previous.visit_id
              FROM buffered_visits previous
              WHERE previous.site_id = v.site_id
                AND previous.session_id = v.session_id
                AND previous.started_at < v.started_at
              ORDER BY previous.started_at DESC, previous.visit_id DESC
              LIMIT 1
            ),
            ''
          ) AS previousVisitId,
          (
            SELECT previous.started_at
            FROM buffered_visits previous
            WHERE previous.site_id = v.site_id
              AND previous.session_id = v.session_id
              AND previous.started_at < v.started_at
            ORDER BY previous.started_at DESC, previous.visit_id DESC
            LIMIT 1
          ) AS previousVisitStartedAt,
          COALESCE(v.pathname, '') AS pathname,
          COALESCE(v.query_string, '') AS queryString,
          COALESCE(v.hash_fragment, '') AS hash,
          COALESCE(v.title, '') AS title,
          COALESCE(v.hostname, '') AS hostname,
          COALESCE(v.referrer_url, '') AS referrerUrl,
          COALESCE(v.referrer_host, '') AS referrerHost,
          COALESCE(v.utm_source, '') AS utmSource,
          COALESCE(v.utm_medium, '') AS utmMedium,
          COALESCE(v.utm_campaign, '') AS utmCampaign,
          COALESCE(v.utm_term, '') AS utmTerm,
          COALESCE(v.utm_content, '') AS utmContent,
          COALESCE(v.visitor_id, '') AS visitorId,
          COALESCE(NULLIF(e.user_id, ''), v.user_id, '') AS userId,
          COALESCE(v.user_name, '') AS userName,
          v.is_eu AS isEU,
          COALESCE(v.country, '') AS country,
          COALESCE(v.region, '') AS region,
          COALESCE(v.region_code, '') AS regionCode,
          COALESCE(v.city, '') AS city,
          COALESCE(v.continent, '') AS continent,
          COALESCE(v.postal_code, '') AS postalCode,
          COALESCE(v.metro_code, '') AS metroCode,
          COALESCE(v.timezone, '') AS timezone,
          COALESCE(v.as_organization, '') AS organization,
          COALESCE(v.ua_raw, '') AS uaRaw,
          COALESCE(v.browser, '') AS browser,
          COALESCE(v.browser_version, '') AS browserVersion,
          COALESCE(v.os, '') AS os,
          COALESCE(v.os_version, '') AS osVersion,
          COALESCE(v.device_type, '') AS deviceType,
          v.screen_width AS screenWidth,
          v.screen_height AS screenHeight,
          COALESCE(v.language, '') AS language,
          COALESCE(v.status, '') AS status,
          v.hidden_at AS hiddenAt,
          v.ended_at AS endedAt,
          v.finalized_at AS finalizedAt,
          v.duration_ms AS durationMs,
          COALESCE(v.duration_source, '') AS durationSource,
          COALESCE(v.exit_reason, '') AS exitReason,
          v.ended_at AS leaveAt,
          '' AS performanceVisitId,
          CASE
            WHEN v.perf_ttfb_ms IS NULL AND v.perf_fcp_ms IS NULL
              AND v.perf_lcp_ms IS NULL AND v.perf_cls IS NULL AND v.perf_inp_ms IS NULL
              THEN NULL
            ELSE json_object(
              'ttfb', v.perf_ttfb_ms,
              'fcp', v.perf_fcp_ms,
              'lcp', v.perf_lcp_ms,
              'cls', v.perf_cls,
              'inp', v.perf_inp_ms
            )
          END AS performance,
          CASE
            WHEN v.status = 'hidden_pending' THEN 'hidden'
            WHEN v.status = 'open' THEN 'visible'
            ELSE ''
          END AS visibilityState,
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
          'leave' AS eventKind,
          ended_at AS eventAt,
          site_id AS siteId,
          '' AS traceId,
          NULL AS receivedAt,
          NULL AS sequence,
          '' AS eventName,
          NULL AS eventDataJson,
          visit_id AS visitId,
          session_id AS sessionId,
          started_at AS startedAt,
          COALESCE(
            (
              SELECT previous.visit_id
              FROM buffered_visits previous
              WHERE previous.site_id = v.site_id
                AND previous.session_id = v.session_id
                AND previous.started_at < v.started_at
              ORDER BY previous.started_at DESC, previous.visit_id DESC
              LIMIT 1
            ),
            ''
          ) AS previousVisitId,
          (
            SELECT previous.started_at
            FROM buffered_visits previous
            WHERE previous.site_id = v.site_id
              AND previous.session_id = v.session_id
              AND previous.started_at < v.started_at
            ORDER BY previous.started_at DESC, previous.visit_id DESC
            LIMIT 1
          ) AS previousVisitStartedAt,
          pathname,
          query_string AS queryString,
          hash_fragment AS hash,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          utm_source AS utmSource,
          utm_medium AS utmMedium,
          utm_campaign AS utmCampaign,
          utm_term AS utmTerm,
          utm_content AS utmContent,
          visitor_id AS visitorId,
          user_id AS userId,
          user_name AS userName,
          is_eu AS isEU,
          country,
          region,
          region_code AS regionCode,
          city,
          continent,
          postal_code AS postalCode,
          metro_code AS metroCode,
          timezone,
          as_organization AS organization,
          ua_raw AS uaRaw,
          browser,
          browser_version AS browserVersion,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          screen_width AS screenWidth,
          screen_height AS screenHeight,
          language,
          status,
          hidden_at AS hiddenAt,
          ended_at AS endedAt,
          finalized_at AS finalizedAt,
          duration_ms AS durationMs,
          duration_source AS durationSource,
          exit_reason AS exitReason,
          ended_at AS leaveAt,
          '' AS performanceVisitId,
          CASE
            WHEN perf_ttfb_ms IS NULL AND perf_fcp_ms IS NULL
              AND perf_lcp_ms IS NULL AND perf_cls IS NULL AND perf_inp_ms IS NULL
              THEN NULL
            ELSE json_object(
              'ttfb', perf_ttfb_ms,
              'fcp', perf_fcp_ms,
              'lcp', perf_lcp_ms,
              'cls', perf_cls,
              'inp', perf_inp_ms
            )
          END AS performance,
          '' AS visibilityState,
          latitude,
          longitude
        FROM buffered_visits v
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
        user_id AS userId,
        user_name AS userName,
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
        language,
        hidden_at AS hiddenAt,
        ended_at AS endedAt,
        finalized_at AS finalizedAt,
        duration_ms AS durationMs,
        duration_source AS durationSource,
        exit_reason AS exitReason,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
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
