import { toUnixSeconds } from "./ingest-time";
import type {
  BufferedCustomEventInput,
  BufferedVisitRow,
  RecentVisitorSession,
  SqlWriter,
  StoredOpenVisit,
  VisitRow,
} from "./ingest-types";
import type {
  Env,
  NormalizedCustomEvent,
  NormalizedPageview,
  TrackerPerformancePayload,
} from "./types";

interface BufferStoreContext extends SqlWriter {
  env: Pick<Env, "DB">;
}

export async function attachPerformanceToVisit(
  context: BufferStoreContext,
  siteId: string,
  visitId: string,
  performance: TrackerPerformancePayload,
  receivedAt: number,
): Promise<void> {
  if (!siteId || !visitId) return;
  const updatedAt = toUnixSeconds(receivedAt);
  const rowsWritten = context.sqlRun(
    `
      UPDATE buffered_visits
      SET perf_ttfb_ms = ?,
          perf_fcp_ms = ?,
          perf_lcp_ms = ?,
          perf_cls = ?,
          perf_inp_ms = ?,
          dirty = 1,
          updated_at = ?
      WHERE site_id = ? AND visit_id = ?
    `,
    performance.ttfb ?? null,
    performance.fcp ?? null,
    performance.lcp ?? null,
    performance.cls ?? null,
    performance.inp ?? null,
    updatedAt,
    siteId,
    visitId,
  );
  if (rowsWritten > 0) return;

  const persistedRow = await readPersistedVisitRow(context, siteId, visitId);
  if (!persistedRow) return;
  insertBufferedVisitRow(context, {
    ...persistedRow,
    perfTtfbMs: performance.ttfb ?? null,
    perfFcpMs: performance.fcp ?? null,
    perfLcpMs: performance.lcp ?? null,
    perfCls: performance.cls ?? null,
    perfInpMs: performance.inp ?? null,
    dirty: 1,
    flushAttempts: 0,
    updatedAt,
  });
}

export async function getVisitContext(
  context: BufferStoreContext,
  siteId: string,
  visitId: string,
): Promise<StoredOpenVisit | null> {
  let row = await readVisitRow(context, siteId, visitId);
  if (!row) {
    const persisted = await readPersistedVisitRow(context, siteId, visitId);
    if (persisted) {
      insertBufferedVisitRow(context, persisted);
      row = persisted;
    }
  }
  if (!row) return null;
  return {
    siteId: row.siteId,
    visitId: row.visitId,
    visitorId: row.visitorId,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    pathname: row.pathname,
    queryString: row.queryString,
    hashFragment: row.hashFragment,
    hostname: row.hostname,
    title: row.title,
    referrerUrl: row.referrerUrl,
    referrerHost: row.referrerHost,
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    utmTerm: row.utmTerm,
    utmContent: row.utmContent,
    isEU: row.isEU === 1,
    country: row.country,
    region: row.region,
    regionCode: row.regionCode,
    city: row.city,
    continent: row.continent,
    latitude: row.latitude,
    longitude: row.longitude,
    postalCode: row.postalCode,
    metroCode: row.metroCode,
    timezone: row.timezone,
    asOrganization: row.asOrganization,
    uaRaw: row.uaRaw,
    browser: row.browser,
    browserVersion: row.browserVersion,
    os: row.os,
    osVersion: row.osVersion,
    deviceType: row.deviceType,
    screenWidth: row.screenWidth,
    screenHeight: row.screenHeight,
    language: row.language,
  };
}

export async function findRecentVisitorSession(
  context: BufferStoreContext,
  input: {
    siteId: string;
    visitorId: string;
    visitId: string;
    startedAt: number;
    sessionWindowMs: number;
    routePreviousHostname?: string;
    routePreviousPathname?: string;
    routePreviousQueryString?: string;
    routePreviousHashFragment?: string;
  },
): Promise<RecentVisitorSession | null> {
  const cutoff = input.startedAt - input.sessionWindowMs;
  const routeMatchEnabled =
    input.routePreviousHostname && input.routePreviousPathname ? 1 : 0;
  const routePreviousHostname = input.routePreviousHostname || "";
  const routePreviousPathname = input.routePreviousPathname || "";
  const routePreviousQueryString = input.routePreviousQueryString || "";
  const routePreviousHashFragment = input.routePreviousHashFragment || "";
  const buffered = context.sqlOne<RecentVisitorSession>(
    `
      SELECT
        session_id AS sessionId,
        visit_id AS visitId,
        status,
        CASE
          WHEN ? = 1
            AND status IN ('open', 'hidden_pending')
            AND hostname = ?
            AND pathname = ?
            AND query_string = ?
            AND hash_fragment = ?
            THEN 2
          WHEN ? = 1
            AND status IN ('open', 'hidden_pending')
            AND hostname = ?
            AND pathname = ?
            AND (query_string = ? OR query_string = '' OR ? = '')
            AND (hash_fragment = ? OR hash_fragment = '' OR ? = '')
            THEN 1
          ELSE 0
        END AS routeMatch,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt
      FROM buffered_visits
      WHERE site_id = ?
        AND visitor_id = ?
        AND visit_id != ?
        AND session_id != ''
        AND last_activity_at >= ?
      ORDER BY
        routeMatch DESC,
        CASE WHEN status IN ('open', 'hidden_pending') THEN 0 ELSE 1 END,
        last_activity_at DESC,
        started_at DESC
      LIMIT 1
    `,
    routeMatchEnabled,
    routePreviousHostname,
    routePreviousPathname,
    routePreviousQueryString,
    routePreviousHashFragment,
    routeMatchEnabled,
    routePreviousHostname,
    routePreviousPathname,
    routePreviousQueryString,
    routePreviousQueryString,
    routePreviousHashFragment,
    routePreviousHashFragment,
    input.siteId,
    input.visitorId,
    input.visitId,
    cutoff,
  );
  if (buffered) return buffered;

  const persisted = await context.env.DB.prepare(
    `
      SELECT
        session_id AS sessionId,
        visit_id AS visitId,
        status,
        CASE
          WHEN ? = 1
            AND status IN ('open', 'hidden_pending')
            AND hostname = ?
            AND pathname = ?
            AND query_string = ?
            AND hash_fragment = ?
            THEN 2
          WHEN ? = 1
            AND status IN ('open', 'hidden_pending')
            AND hostname = ?
            AND pathname = ?
            AND (query_string = ? OR query_string = '' OR ? = '')
            AND (hash_fragment = ? OR hash_fragment = '' OR ? = '')
            THEN 1
          ELSE 0
        END AS routeMatch,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt
      FROM visits
      WHERE site_id = ?
        AND visitor_id = ?
        AND visit_id != ?
        AND session_id != ''
        AND last_activity_at >= ?
      ORDER BY
        routeMatch DESC,
        CASE WHEN status IN ('open', 'hidden_pending') THEN 0 ELSE 1 END,
        last_activity_at DESC,
        started_at DESC
      LIMIT 1
    `,
  )
    .bind(
      routeMatchEnabled,
      routePreviousHostname,
      routePreviousPathname,
      routePreviousQueryString,
      routePreviousHashFragment,
      routeMatchEnabled,
      routePreviousHostname,
      routePreviousPathname,
      routePreviousQueryString,
      routePreviousQueryString,
      routePreviousHashFragment,
      routePreviousHashFragment,
      input.siteId,
      input.visitorId,
      input.visitId,
      cutoff,
    )
    .first<RecentVisitorSession>();

  return persisted ?? null;
}

export async function readVisitRow(
  context: Pick<BufferStoreContext, "sqlOne">,
  siteId: string,
  visitId: string,
): Promise<VisitRow | null> {
  return context.sqlOne<VisitRow>(
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
        language,
        COALESCE(user_id, '') AS userId,
        COALESCE(user_name, '') AS userName,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
      FROM buffered_visits
      WHERE site_id = ? AND visit_id = ?
      LIMIT 1
    `,
    siteId,
    visitId,
  );
}

export async function readPersistedVisitRow(
  context: Pick<BufferStoreContext, "env">,
  siteId: string,
  visitId: string,
): Promise<BufferedVisitRow | null> {
  const row = await context.env.DB.prepare(
    `
      SELECT
        visit_id AS visitId,
        status,
        site_id AS siteId,
        visitor_id AS visitorId,
        session_id AS sessionId,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        ended_at AS endedAt,
        finalized_at AS finalizedAt,
        duration_ms AS durationMs,
        COALESCE(duration_source, '') AS durationSource,
        COALESCE(exit_reason, '') AS exitReason,
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
        COALESCE(user_id, '') AS userId,
        COALESCE(user_name, '') AS userName,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM visits
      WHERE site_id = ? AND visit_id = ?
      LIMIT 1
    `,
  )
    .bind(siteId, visitId)
    .first<BufferedVisitRow>();

  return row
    ? {
        ...row,
        dirty: 0,
        flushAttempts: 0,
        hiddenAt: null,
      }
    : null;
}

export function insertBufferedVisitRow(
  context: Pick<BufferStoreContext, "sqlRun">,
  row: BufferedVisitRow,
): void {
  const bindings: Array<string | number | null> = [
    row.visitId,
    row.siteId,
    row.visitorId,
    row.sessionId,
    row.status,
    row.startedAt,
    row.lastActivityAt,
    row.hiddenAt ?? null,
    row.endedAt,
    row.finalizedAt,
    row.durationMs,
    row.durationSource || null,
    row.exitReason || null,
    row.pathname,
    row.queryString,
    row.hashFragment,
    row.hostname,
    row.title,
    row.referrerUrl,
    row.referrerHost,
    row.utmSource,
    row.utmMedium,
    row.utmCampaign,
    row.utmTerm,
    row.utmContent,
    row.isEU,
    row.country,
    row.region,
    row.regionCode,
    row.city,
    row.continent,
    row.latitude,
    row.longitude,
    row.postalCode,
    row.metroCode,
    row.timezone,
    row.asOrganization,
    row.uaRaw,
    row.browser,
    row.browserVersion,
    row.os,
    row.osVersion,
    row.deviceType,
    row.screenWidth,
    row.screenHeight,
    row.language,
    row.userId || "",
    row.userName || "",
    row.perfTtfbMs,
    row.perfFcpMs,
    row.perfLcpMs,
    row.perfCls,
    row.perfInpMs,
    row.dirty,
    row.flushAttempts,
    null,
    row.createdAt,
    row.updatedAt,
  ];
  context.sqlRun(
    `
      INSERT OR REPLACE INTO buffered_visits (
        visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
        hidden_at, ended_at, finalized_at, duration_ms, duration_source, exit_reason,
        pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        is_eu, country, region, region_code, city, continent, latitude, longitude,
        postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
        os, os_version, device_type, screen_width, screen_height, language,
        user_id, user_name,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms,
        dirty, flush_attempts, last_flush_error, created_at, updated_at
      ) VALUES (${bindings.map(() => "?").join(", ")})
    `,
    ...bindings,
  );
}

export async function insertVisit(
  context: Pick<BufferStoreContext, "sqlRun">,
  record: NormalizedPageview,
): Promise<boolean> {
  const createdAt = toUnixSeconds(record.receivedAt);
  const bindings: Array<string | number | null> = [
    record.visitId,
    record.siteId,
    record.visitorId,
    record.sessionId,
    "open",
    record.startedAt,
    record.startedAt,
    record.pathname,
    record.queryString,
    record.hashFragment,
    record.hostname,
    record.title,
    record.referrerUrl,
    record.referrerHost,
    record.utmSource,
    record.utmMedium,
    record.utmCampaign,
    record.utmTerm,
    record.utmContent,
    record.isEU ? 1 : 0,
    record.country,
    record.region,
    record.regionCode,
    record.city,
    record.continent,
    record.latitude,
    record.longitude,
    record.postalCode,
    record.metroCode,
    record.timezone,
    record.asOrganization,
    record.uaRaw,
    record.browser,
    record.browserVersion,
    record.os,
    record.osVersion,
    record.deviceType,
    record.screenWidth,
    record.screenHeight,
    record.language,
    record.userId || "",
    record.userName || "",
    null,
    null,
    null,
    null,
    null,
    1,
    0,
    null,
    createdAt,
    createdAt,
  ];
  const rowsWritten = context.sqlRun(
    `
      INSERT INTO buffered_visits (
          visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
          pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          is_eu, country, region, region_code, city, continent, latitude, longitude,
          postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
          os, os_version, device_type, screen_width, screen_height, language,
          user_id, user_name,
          perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms,
          dirty, flush_attempts, last_flush_error, created_at, updated_at
        ) VALUES (${bindings.map(() => "?").join(", ")})
        ON CONFLICT(visit_id) DO NOTHING
      `,
    ...bindings,
  );
  return rowsWritten > 0;
}

export async function insertCustomEvent(
  context: Pick<BufferStoreContext, "sqlRun">,
  record: NormalizedCustomEvent,
): Promise<boolean> {
  return insertBufferedCustomEvent(context, {
    eventId: record.eventId,
    siteId: record.siteId,
    visitId: record.visitId,
    occurredAt: record.eventAt,
    receivedAt: record.receivedAt,
    sequence: record.sequence,
    eventName: record.eventName,
    eventDataJson: record.eventDataJson,
    userId: record.userId || "",
  });
}

export function insertBufferedCustomEvent(
  context: Pick<BufferStoreContext, "sqlRun">,
  record: BufferedCustomEventInput,
): boolean {
  const createdAt = toUnixSeconds(record.receivedAt);
  const rowsWritten = context.sqlRun(
    `
      INSERT OR IGNORE INTO buffered_custom_events (
        event_id, site_id, visit_id, occurred_at, received_at, sequence,
        event_name, event_data_json, user_id,
        dirty, flush_attempts, last_flush_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?)
    `,
    record.eventId,
    record.siteId,
    record.visitId,
    record.occurredAt,
    record.receivedAt,
    record.sequence,
    record.eventName,
    record.eventDataJson,
    record.userId || "",
    createdAt,
  );
  return rowsWritten > 0;
}

export async function updateOpenVisitActivity(
  context: Pick<BufferStoreContext, "sqlRun">,
  visitId: string,
  eventAt: number,
): Promise<void> {
  const updatedAt = toUnixSeconds(Date.now());
  context.sqlRun(
    `
      UPDATE buffered_visits
      SET last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END,
          dirty = 1,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE visit_id = ? AND status = 'open'
    `,
    eventAt,
    eventAt,
    updatedAt,
    updatedAt,
    visitId,
  );
}
