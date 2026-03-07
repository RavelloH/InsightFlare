import { DurableObject } from "cloudflare:workers";
import { UAParser } from "ua-parser-js";
import type {
  Env,
  IngestEnvelopePayload,
  NormalizedCustomEvent,
  NormalizedIngestRecord,
  NormalizedVisitContext,
  NormalizedVisitFinalize,
  NormalizedVisitStart,
  TrackerClientPayload,
  TrackerPayloadKind,
} from "./types";
import { readSiteTrackingConfig } from "./site-settings-store";
import {
  clampString,
  coerceNumber,
  coerceString,
  deriveEuVisitorId,
  safeHostname,
} from "./utils";

const RECENT_EVENT_RETENTION_MS = 30 * 60 * 1000;
const RECENT_EVENT_QUERY_SCAN_LIMIT = 20_000;
const ACTIVE_NOW_WINDOW_MS = 5 * 60 * 1000;
const VISIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const WS_SNAPSHOT_EVENT_LIMIT = 200;
const WS_PRESENCE_LEAVE_EVENT = "__presence_leave";
const WRITE_BUDGET_PER_INVOCATION = 200;
const D1_FLUSH_INTERVAL_MS = 60 * 1000;
const D1_FLUSH_BATCH_SIZE = 100;
const D1_FLUSH_IMMEDIATE_THRESHOLD = WRITE_BUDGET_PER_INVOCATION;
const OPEN_VISIT_FLUSH_THRESHOLD = WRITE_BUDGET_PER_INVOCATION * 5;
const TIMEOUT_FINALIZE_BATCH_SIZE = WRITE_BUDGET_PER_INVOCATION;
const LOCAL_DEDUPE_RETENTION_MS = 48 * 60 * 60 * 1000;

interface RealtimeSnapshotRecord {
  id: string;
  eventType: string;
  eventAt: number;
  pathname: string;
  visitorId: string;
  country: string;
  browser: string;
}

interface StoredOpenVisit extends NormalizedVisitContext {
  lastActivityAt: number;
}

interface VisitRow {
  visitId: string;
  status: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  isEU: number;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  asOrganization: string;
  uaRaw: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  language: string;
}

interface BufferedVisitRow extends VisitRow {
  lastActivityAt: number;
  endedAt: number | null;
  finalizedAt: number | null;
  durationMs: number | null;
  durationSource: string;
  exitReason: string;
  dirty: number;
  flushAttempts: number;
  createdAt: number;
  updatedAt: number;
}

interface BufferedCustomEventRow {
  eventId: string;
  siteId: string;
  visitId: string;
  visitorId: string;
  sessionId: string;
  occurredAt: number;
  eventName: string;
  eventDataJson: string;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referrerUrl: string;
  referrerHost: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  os: string;
  osVersion: string;
  deviceType: string;
  language: string;
  timezone: string;
  screenWidth: number | null;
  screenHeight: number | null;
  dirty: number;
  flushAttempts: number;
  createdAt: number;
}

type SqlBinding = string | number | null;

const UPSERT_VISIT_SQL = `
  INSERT INTO visits (
    visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
    ended_at, finalized_at, duration_ms, duration_source, exit_reason,
    pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    is_eu, country, region, region_code, city, continent, latitude, longitude,
    postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
    os, os_version, device_type, screen_width, screen_height, language, ae_synced_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(visit_id) DO UPDATE SET
    site_id = excluded.site_id,
    visitor_id = excluded.visitor_id,
    session_id = excluded.session_id,
    status = excluded.status,
    started_at = excluded.started_at,
    last_activity_at = excluded.last_activity_at,
    ended_at = excluded.ended_at,
    finalized_at = excluded.finalized_at,
    duration_ms = excluded.duration_ms,
    duration_source = excluded.duration_source,
    exit_reason = excluded.exit_reason,
    pathname = excluded.pathname,
    query_string = excluded.query_string,
    hash_fragment = excluded.hash_fragment,
    hostname = excluded.hostname,
    title = excluded.title,
    referrer_url = excluded.referrer_url,
    referrer_host = excluded.referrer_host,
    utm_source = excluded.utm_source,
    utm_medium = excluded.utm_medium,
    utm_campaign = excluded.utm_campaign,
    utm_term = excluded.utm_term,
    utm_content = excluded.utm_content,
    is_eu = excluded.is_eu,
    country = excluded.country,
    region = excluded.region,
    region_code = excluded.region_code,
    city = excluded.city,
    continent = excluded.continent,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    postal_code = excluded.postal_code,
    metro_code = excluded.metro_code,
    timezone = excluded.timezone,
    as_organization = excluded.as_organization,
    ua_raw = excluded.ua_raw,
    browser = excluded.browser,
    browser_version = excluded.browser_version,
    os = excluded.os,
    os_version = excluded.os_version,
    device_type = excluded.device_type,
    screen_width = excluded.screen_width,
    screen_height = excluded.screen_height,
    language = excluded.language,
    ae_synced_at = excluded.ae_synced_at,
    updated_at = excluded.updated_at
`;

const INSERT_CUSTOM_EVENT_SQL = `
  INSERT INTO custom_events (
    event_id, site_id, visit_id, visitor_id, session_id, occurred_at, event_name, event_data_json,
    pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
    country, region, city, browser, os, os_version, device_type, language, timezone,
    screen_width, screen_height, ae_synced_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id) DO NOTHING
`;

function toUnixSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

function visitBindings(row: BufferedVisitRow): SqlBinding[] {
  return [
    row.visitId,
    row.siteId,
    row.visitorId,
    row.sessionId,
    row.status,
    row.startedAt,
    row.lastActivityAt,
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
    null,
    row.createdAt,
    row.updatedAt,
  ];
}

function customEventBindings(row: BufferedCustomEventRow): SqlBinding[] {
  return [
    row.eventId,
    row.siteId,
    row.visitId,
    row.visitorId,
    row.sessionId,
    row.occurredAt,
    row.eventName,
    row.eventDataJson,
    row.pathname,
    row.queryString,
    row.hashFragment,
    row.hostname,
    row.title,
    row.referrerUrl,
    row.referrerHost,
    row.country,
    row.region,
    row.city,
    row.browser,
    row.os,
    row.osVersion,
    row.deviceType,
    row.language,
    row.timezone,
    row.screenWidth,
    row.screenHeight,
    null,
    row.createdAt,
  ];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clampTimestamp(input: unknown, fallback: number): number {
  const value = coerceNumber(input, fallback) ?? fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function matchesBlockedPath(pathname: string, blockedPaths: string[]): boolean {
  for (const blockedPath of blockedPaths) {
    if (!blockedPath) continue;
    if (pathname === blockedPath || pathname.startsWith(`${blockedPath}/`)) {
      return true;
    }
  }
  return false;
}

function toEventDataJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? null).slice(0, 4000);
  } catch {
    return "null";
  }
}

function toRealtimePayload(record: RealtimeSnapshotRecord): Record<string, unknown> {
  return {
    id: record.id,
    eventType: record.eventType,
    eventAt: record.eventAt,
    pathname: record.pathname,
    visitorId: record.visitorId,
    country: record.country,
    browser: record.browser,
  };
}

export class IngestDurableObject extends DurableObject {
  private readonly doState: DurableObjectState;
  private readonly doEnv: Env;
  private readonly schemaReady: Promise<void>;
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.doState = state;
    this.doEnv = env;
    this.schemaReady = this.doState.blockConcurrencyWhile(async () => {
      this.initializeSqlSchema();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.schemaReady;
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request, url);
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      return this.handleIngest(request);
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      return this.handleSnapshot(url);
    }

    if (url.pathname === "/flush" && request.method === "POST") {
      await this.flushTimeouts();
      await this.flushPendingToD1();
      return jsonResponse({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.schemaReady;
    await this.flushTimeouts();
    await this.flushPendingToD1();
    await this.cleanupBufferedRows();
    if ((await this.hasOpenVisits()) || this.hasDirtyRows()) {
      await this.doState.storage.setAlarm(Date.now() + D1_FLUSH_INTERVAL_MS);
      return;
    }
    await this.doState.storage.deleteAlarm();
  }

  private async handleIngest(request: Request): Promise<Response> {
    let envelope: IngestEnvelopePayload;
    try {
      envelope = (await request.json()) as IngestEnvelopePayload;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const record = await this.normalizeRecord(envelope);
    if (!record) {
      return new Response("ignored", { status: 202 });
    }

    if (record.kind === "visit_start") {
      await this.handleVisitStart(record);
    } else if (record.kind === "visit_finalize") {
      await this.handleVisitFinalize(record);
    } else {
      await this.handleCustomEvent(record);
    }

    await this.maybeFlushToD1();
    await this.ensureAlarm();
    return new Response("ok", { status: 202 });
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    if (this.doEnv.ADMIN_WS_TOKEN) {
      const tokenFromQuery = url.searchParams.get("token");
      if (tokenFromQuery !== this.doEnv.ADMIN_WS_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);
    void this.pushInitialSnapshotToSocket(server);

    server.addEventListener("close", () => {
      this.sockets.delete(server);
    });
    server.addEventListener("error", () => {
      this.sockets.delete(server);
      try {
        server.close();
      } catch {
        // no-op
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleSnapshot(url: URL): Promise<Response> {
    const fromMsRaw = Number(url.searchParams.get("from") || "0");
    const toMsRaw = Number(url.searchParams.get("to") || String(Date.now()));
    const limitRaw = Number(url.searchParams.get("limit") || "5000");

    const fromMs = Number.isFinite(fromMsRaw) ? Math.max(0, Math.floor(fromMsRaw)) : 0;
    const toMs = Number.isFinite(toMsRaw) ? Math.max(fromMs, Math.floor(toMsRaw)) : Date.now();
    const limit = Number.isFinite(limitRaw)
      ? Math.min(RECENT_EVENT_QUERY_SCAN_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : 5000;

    return jsonResponse({
      ok: true,
      buffered: 0,
      data: this.readRecentRealtimeEvents(fromMs, toMs, limit),
    });
  }

  private initializeSqlSchema(): void {
    const sql = this.doState.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS buffered_visits (
        visit_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        ended_at INTEGER,
        finalized_at INTEGER,
        duration_ms INTEGER,
        duration_source TEXT,
        exit_reason TEXT,
        pathname TEXT NOT NULL,
        query_string TEXT NOT NULL DEFAULT '',
        hash_fragment TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        referrer_url TEXT NOT NULL DEFAULT '',
        referrer_host TEXT NOT NULL DEFAULT '',
        utm_source TEXT NOT NULL DEFAULT '',
        utm_medium TEXT NOT NULL DEFAULT '',
        utm_campaign TEXT NOT NULL DEFAULT '',
        utm_term TEXT NOT NULL DEFAULT '',
        utm_content TEXT NOT NULL DEFAULT '',
        is_eu INTEGER NOT NULL DEFAULT 0,
        country TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        region_code TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        continent TEXT NOT NULL DEFAULT '',
        latitude REAL,
        longitude REAL,
        postal_code TEXT NOT NULL DEFAULT '',
        metro_code TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        as_organization TEXT NOT NULL DEFAULT '',
        ua_raw TEXT NOT NULL DEFAULT '',
        browser TEXT NOT NULL DEFAULT '',
        browser_version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        os_version TEXT NOT NULL DEFAULT '',
        device_type TEXT NOT NULL DEFAULT '',
        screen_width INTEGER,
        screen_height INTEGER,
        language TEXT NOT NULL DEFAULT '',
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec("DROP INDEX IF EXISTS idx_buffered_visits_dirty_updated");
    sql.exec("DROP INDEX IF EXISTS idx_buffered_visits_status_last_activity");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS buffered_custom_events (
        event_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        event_data_json TEXT NOT NULL DEFAULT '{}',
        pathname TEXT NOT NULL,
        query_string TEXT NOT NULL DEFAULT '',
        hash_fragment TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        referrer_url TEXT NOT NULL DEFAULT '',
        referrer_host TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        browser TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        os_version TEXT NOT NULL DEFAULT '',
        device_type TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        screen_width INTEGER,
        screen_height INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_dirty_occurred");
  }

  private sqlAll<T>(query: string, ...bindings: SqlBinding[]): T[] {
    return this.doState.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  private sqlOne<T>(query: string, ...bindings: SqlBinding[]): T | null {
    const rows = this.sqlAll<T>(query, ...bindings);
    return rows[0] ?? null;
  }

  private sqlRun(query: string, ...bindings: SqlBinding[]): number {
    return this.doState.storage.sql.exec(query, ...bindings).rowsWritten;
  }

  private hasDirtyRows(): boolean {
    const visits = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_visits WHERE dirty = 1");
    if ((visits?.count ?? 0) > 0) return true;
    const events = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_custom_events WHERE dirty = 1");
    return (events?.count ?? 0) > 0;
  }

  private async maybeFlushToD1(): Promise<void> {
    const visitCount = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_visits WHERE dirty = 1 AND status != 'open'")?.count ?? 0;
    const eventCount = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_custom_events WHERE dirty = 1")?.count ?? 0;
    const openVisitCount = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_visits WHERE dirty = 1 AND status = 'open'")?.count ?? 0;
    if (
      visitCount >= D1_FLUSH_IMMEDIATE_THRESHOLD ||
      eventCount >= D1_FLUSH_IMMEDIATE_THRESHOLD ||
      openVisitCount >= OPEN_VISIT_FLUSH_THRESHOLD
    ) {
      await this.flushPendingToD1();
    }
  }
  private async normalizeRecord(envelope: IngestEnvelopePayload): Promise<NormalizedIngestRecord | null> {
    const client = envelope.client ?? ({} as TrackerClientPayload);
    const siteId = clampString(coerceString(client.siteId), 120);
    if (!siteId) return null;

    const config = await readSiteTrackingConfig(this.doEnv, siteId);
    if (!config?.siteDomain) return null;

    const requestHeaders = envelope.request.headers ?? {};
    const requestUrl = new URL(envelope.request.url);
    const nowMs = Date.now();
    const receivedAt = clampTimestamp(envelope.request.receivedAt, nowMs);
    const eventAt = clampTimestamp(client.timestamp, nowMs);
    const startedAt = clampTimestamp(client.startedAt, eventAt);
    const kind = clampString(coerceString(client.kind), 40) as TrackerPayloadKind;
    const visitId = clampString(coerceString(client.visitId), 128);

    const cf = envelope.request.cf ?? {};
    const uaRaw = clampString(coerceString(requestHeaders["user-agent"] ?? ""), 1024);
    const parser = new UAParser(uaRaw);
    const ua = parser.getResult();
    const isEU = Boolean(cf.isEUCountry);

    let visitorId = clampString(coerceString(client.visitorId), 128);
    if (isEU || !visitorId) {
      const ip = clampString(
        coerceString(requestHeaders["cf-connection-ip"] ?? requestHeaders["x-forwarded-for"] ?? ""),
        80,
      );
      visitorId = await deriveEuVisitorId({
        ip,
        ua: uaRaw,
        eventAtMs: eventAt,
        secret: this.doEnv.DAILY_SALT_SECRET,
      });
    }

    const contextGeoBase = {
      isEU,
      country: clampString(coerceString(cf.country ?? ""), 10),
      region: clampString(coerceString(cf.region ?? ""), 128),
      regionCode: clampString(coerceString(cf.regionCode ?? ""), 32),
      city: clampString(coerceString(cf.city ?? ""), 128),
      continent: clampString(coerceString(cf.continent ?? ""), 32),
      latitude: coerceNumber(cf.latitude, null),
      longitude: coerceNumber(cf.longitude, null),
      postalCode: clampString(coerceString(cf.postalCode ?? ""), 32),
      metroCode: clampString(coerceString(cf.metroCode ?? ""), 32),
      timezone: clampString(coerceString(client.timezone || cf.timezone || ""), 120),
      asOrganization: clampString(coerceString(cf.asOrganization ?? ""), 255),
      uaRaw,
      browser: clampString(coerceString(ua.browser.name ?? ""), 80),
      browserVersion: clampString(coerceString(ua.browser.version ?? ""), 80),
      os: clampString(coerceString(ua.os.name ?? ""), 80),
      osVersion: clampString(coerceString(ua.os.version ?? ""), 80),
      deviceType: clampString(coerceString(ua.device.type ?? "desktop"), 40),
    };

    if (kind === "visit_start") {
      if (!visitId) return null;
      const pathname = clampString(coerceString(client.pathname || "/"), 2048);
      const hostname = clampString(
        coerceString(client.hostname || safeHostname(requestUrl.toString())),
        255,
      ).toLowerCase();
      if (!hostname || !config.allowedHostnames.includes(hostname)) {
        return null;
      }
      if (matchesBlockedPath(pathname, config.pathBlacklist)) {
        return null;
      }
      const referrerUrl = clampString(coerceString(client.referrerUrl), 2000);
      const sessionId = clampString(coerceString(client.sessionId), 128) || crypto.randomUUID();
      return {
        kind: "visit_start",
        receivedAt,
        siteId,
        visitId,
        visitorId,
        sessionId,
        startedAt,
        pathname,
        queryString: clampString(coerceString(client.query || ""), 2048),
        hashFragment: clampString(coerceString(client.hash || ""), 1024),
        hostname,
        title: clampString(coerceString(client.title || ""), 1024),
        referrerUrl,
        referrerHost: clampString(safeHostname(referrerUrl), 255),
        utmSource: clampString(coerceString(client.utmSource || ""), 255),
        utmMedium: clampString(coerceString(client.utmMedium || ""), 255),
        utmCampaign: clampString(coerceString(client.utmCampaign || ""), 255),
        utmTerm: clampString(coerceString(client.utmTerm || ""), 255),
        utmContent: clampString(coerceString(client.utmContent || ""), 255),
        screenWidth: coerceNumber(client.screenWidth, null),
        screenHeight: coerceNumber(client.screenHeight, null),
        language: clampString(coerceString(client.language || ""), 120),
        ...contextGeoBase,
      } satisfies NormalizedVisitStart;
    }

    if (kind === "visit_finalize") {
      if (!visitId) return null;
      const visit = await this.getVisitContext(siteId, visitId);
      if (!visit) return null;
      return {
        kind: "visit_finalize",
        siteId,
        visitId,
        visitorId: visit.visitorId,
        sessionId: visit.sessionId,
        startedAt: visit.startedAt,
        finalizedAt: eventAt,
        receivedAt,
        durationMs: coerceNumber(client.durationMs, null),
        durationSource: "reported",
        exitReason: clampString(coerceString(client.exitReason || "pagehide"), 80),
        country: visit.country,
        browser: visit.browser,
        deviceType: visit.deviceType,
      } satisfies NormalizedVisitFinalize;
    }

    if (kind === "custom_event") {
      if (!visitId) return null;
      const eventName = clampString(coerceString(client.eventName), 120);
      if (!eventName) return null;
      const visit = await this.getVisitContext(siteId, visitId);
      if (!visit) return null;
      return {
        kind: "custom_event",
        eventId: clampString(coerceString(client.eventId || crypto.randomUUID()), 128),
        receivedAt,
        eventAt,
        eventName,
        eventDataJson: toEventDataJson(client.eventData),
        siteId: visit.siteId,
        visitId: visit.visitId,
        visitorId: visit.visitorId,
        sessionId: visit.sessionId,
        startedAt: visit.startedAt,
        pathname: visit.pathname,
        queryString: visit.queryString,
        hashFragment: visit.hashFragment,
        hostname: visit.hostname,
        title: visit.title,
        referrerUrl: visit.referrerUrl,
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
        utmTerm: visit.utmTerm,
        utmContent: visit.utmContent,
        isEU: visit.isEU,
        country: visit.country,
        region: visit.region,
        regionCode: visit.regionCode,
        city: visit.city,
        continent: visit.continent,
        latitude: visit.latitude,
        longitude: visit.longitude,
        postalCode: visit.postalCode,
        metroCode: visit.metroCode,
        timezone: visit.timezone,
        asOrganization: visit.asOrganization,
        uaRaw: visit.uaRaw,
        browser: visit.browser,
        browserVersion: visit.browserVersion,
        os: visit.os,
        osVersion: visit.osVersion,
        deviceType: visit.deviceType,
        screenWidth: visit.screenWidth,
        screenHeight: visit.screenHeight,
        language: visit.language,
      } satisfies NormalizedCustomEvent;
    }

    return null;
  }

  private async handleVisitStart(record: NormalizedVisitStart): Promise<void> {
    const inserted = await this.insertVisit(record);
    if (!inserted) {
      return;
    }
    await this.pushRealtimeRecord({
      id: record.visitId,
      eventType: "visit",
      eventAt: record.startedAt,
      pathname: record.pathname,
      visitorId: record.visitorId,
      country: record.country,
      browser: record.browser,
    });
  }

  private async handleVisitFinalize(record: NormalizedVisitFinalize): Promise<void> {
    const visit = await this.readVisitRow(record.siteId, record.visitId);
    if (!visit || visit.status !== "open") {
      return;
    }

    const finalizedAt = Math.max(record.finalizedAt, visit.startedAt);
    const durationMs = typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? Math.max(0, Math.floor(record.durationMs))
      : Math.max(0, finalizedAt - visit.startedAt);

    const rowsWritten = this.sqlRun(
      `
        UPDATE buffered_visits
        SET status = 'finalized',
            last_activity_at = ?,
            ended_at = ?,
            finalized_at = ?,
            duration_ms = ?,
            duration_source = ?,
            exit_reason = ?,
            dirty = 1,
            updated_at = ?
        WHERE site_id = ? AND visit_id = ? AND status = 'open'
      `,
      finalizedAt,
      finalizedAt,
      finalizedAt,
      durationMs,
      record.durationSource,
      record.exitReason,
      toUnixSeconds(record.receivedAt),
      record.siteId,
      record.visitId,
    );
    if (rowsWritten === 0) {
      return;
    }

    if (record.exitReason !== "route_change" && !this.hasOpenVisitsForVisitor(record.siteId, record.visitorId)) {
      await this.pushRealtimeRecord({
        id: `leave:${record.visitId}`,
        eventType: WS_PRESENCE_LEAVE_EVENT,
        eventAt: finalizedAt,
        pathname: visit.pathname,
        visitorId: record.visitorId,
        country: visit.country,
        browser: visit.browser,
      });
    }
  }

  private async handleCustomEvent(record: NormalizedCustomEvent): Promise<void> {
    const inserted = await this.insertCustomEvent(record);
    if (!inserted) {
      return;
    }
    await this.updateOpenVisitActivity(record.visitId, record.eventAt);
    await this.pushRealtimeRecord({
      id: record.eventId,
      eventType: record.eventName,
      eventAt: record.eventAt,
      pathname: record.pathname,
      visitorId: record.visitorId,
      country: record.country,
      browser: record.browser,
    });
  }
  private async getVisitContext(siteId: string, visitId: string): Promise<StoredOpenVisit | null> {
    const row = await this.readVisitRow(siteId, visitId);
    if (!row) return null;
    return {
      siteId: row.siteId,
      visitId: row.visitId,
      visitorId: row.visitorId,
      sessionId: row.sessionId,
      startedAt: row.startedAt,
      lastActivityAt: row.startedAt,
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

  private async readVisitRow(siteId: string, visitId: string): Promise<VisitRow | null> {
    return this.sqlOne<VisitRow>(
      `
        SELECT
          visit_id AS visitId,
          status,
          site_id AS siteId,
          visitor_id AS visitorId,
          session_id AS sessionId,
          started_at AS startedAt,
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
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
      siteId,
      visitId,
    );
  }

  private async insertVisit(record: NormalizedVisitStart): Promise<boolean> {
    const createdAt = toUnixSeconds(record.receivedAt);
    const rowsWritten = this.sqlRun(
      `
        INSERT OR IGNORE INTO buffered_visits (
          visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
          pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          is_eu, country, region, region_code, city, continent, latitude, longitude,
          postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
          os, os_version, device_type, screen_width, screen_height, language,
          dirty, flush_attempts, last_flush_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)
      `,
      record.visitId,
      record.siteId,
      record.visitorId,
      record.sessionId,
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
      createdAt,
      createdAt,
    );
    return rowsWritten > 0;
  }

  private async insertCustomEvent(record: NormalizedCustomEvent): Promise<boolean> {
    const createdAt = toUnixSeconds(record.receivedAt);
    const rowsWritten = this.sqlRun(
      `
        INSERT OR IGNORE INTO buffered_custom_events (
          event_id, site_id, visit_id, visitor_id, session_id, occurred_at, event_name, event_data_json,
          pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
          country, region, city, browser, os, os_version, device_type, language, timezone,
          screen_width, screen_height, dirty, flush_attempts, last_flush_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?)
      `,
      record.eventId,
      record.siteId,
      record.visitId,
      record.visitorId,
      record.sessionId,
      record.eventAt,
      record.eventName,
      record.eventDataJson,
      record.pathname,
      record.queryString,
      record.hashFragment,
      record.hostname,
      record.title,
      record.referrerUrl,
      record.referrerHost,
      record.country,
      record.region,
      record.city,
      record.browser,
      record.os,
      record.osVersion,
      record.deviceType,
      record.language,
      record.timezone,
      record.screenWidth,
      record.screenHeight,
      createdAt,
    );
    return rowsWritten > 0;
  }

  private async updateOpenVisitActivity(visitId: string, eventAt: number): Promise<void> {
    this.sqlRun(
      `
        UPDATE buffered_visits
        SET last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END
        WHERE visit_id = ? AND status = 'open'
      `,
      eventAt,
      eventAt,
      visitId,
    );
  }

  private async pushRealtimeRecord(record: RealtimeSnapshotRecord): Promise<void> {
    await this.pushToWebsocketClients(record);
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.doState.storage.getAlarm();
    if (!existing) {
      await this.doState.storage.setAlarm(Date.now() + D1_FLUSH_INTERVAL_MS);
    }
  }

  private async hasOpenVisits(): Promise<boolean> {
    const row = this.sqlOne<{ count: number }>("SELECT count(*) AS count FROM buffered_visits WHERE status = 'open' LIMIT 1");
    return (row?.count ?? 0) > 0;
  }

  private hasOpenVisitsForVisitor(siteId: string, visitorId: string): boolean {
    const row = this.sqlOne<{ count: number }>(
      `
        SELECT count(*) AS count
        FROM buffered_visits
        WHERE site_id = ?
          AND visitor_id = ?
          AND status = 'open'
        LIMIT 1
      `,
      siteId,
      visitorId,
    );
    return (row?.count ?? 0) > 0;
  }

  private readRecentRealtimeEvents(fromMs: number, toMs: number, limit: number): Array<Record<string, unknown>> {
    const rows = this.sqlAll<RealtimeSnapshotRecord>(
      `
        SELECT
          id,
          eventType,
          eventAt,
          pathname,
          visitorId,
          country,
          browser
        FROM (
          SELECT
            visit_id AS id,
            'visit' AS eventType,
            started_at AS eventAt,
            pathname,
            visitor_id AS visitorId,
            country,
            browser
          FROM buffered_visits
          WHERE started_at BETWEEN ? AND ?
          UNION ALL
          SELECT
            event_id AS id,
            event_name AS eventType,
            occurred_at AS eventAt,
            pathname,
            visitor_id AS visitorId,
            country,
            browser
          FROM buffered_custom_events
          WHERE occurred_at BETWEEN ? AND ?
        )
        ORDER BY eventAt DESC
        LIMIT ?
      `,
      fromMs,
      toMs,
      fromMs,
      toMs,
      limit,
    );
    return rows.map((row) => toRealtimePayload(row));
  }

  private async pushInitialSnapshotToSocket(socket: WebSocket): Promise<void> {
    try {
      const cutoffMs = Date.now() - ACTIVE_NOW_WINDOW_MS;
      const events = this.readRecentRealtimeEvents(
        Math.max(0, Date.now() - RECENT_EVENT_RETENTION_MS),
        Date.now(),
        WS_SNAPSHOT_EVENT_LIMIT,
      );
      const activeNow = this.sqlOne<{ count: number }>(
        `
          SELECT count(DISTINCT visitor_id) AS count
          FROM buffered_visits
          WHERE status = 'open'
            AND last_activity_at >= ?
        `,
        cutoffMs,
      )?.count ?? 0;

      socket.send(JSON.stringify({
        type: "snapshot",
        data: {
          activeNow,
          events,
          buffered: events.length,
        },
      }));
    } catch (error) {
      console.error("ws_snapshot_init_failed", error);
    }
  }

  private async pushToWebsocketClients(record: RealtimeSnapshotRecord): Promise<void> {
    if (this.sockets.size === 0) return;

    const payload = JSON.stringify({
      type: "event",
      data: toRealtimePayload(record),
    });
    const staleSockets: WebSocket[] = [];

    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        staleSockets.push(socket);
      }
    }

    for (const socket of staleSockets) {
      this.sockets.delete(socket);
      try {
        socket.close();
      } catch {
        // no-op
      }
    }
  }

  private async flushPendingToD1(): Promise<void> {
    while (true) {
      const visitRows = this.sqlAll<BufferedVisitRow>(
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
            dirty,
            flush_attempts AS flushAttempts,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM buffered_visits
          WHERE dirty = 1
          ORDER BY updated_at ASC, started_at ASC
          LIMIT ?
        `,
        D1_FLUSH_BATCH_SIZE,
      );
      const eventRows = this.sqlAll<BufferedCustomEventRow>(
        `
          SELECT
            event_id AS eventId,
            site_id AS siteId,
            visit_id AS visitId,
            visitor_id AS visitorId,
            session_id AS sessionId,
            occurred_at AS occurredAt,
            event_name AS eventName,
            event_data_json AS eventDataJson,
            pathname,
            query_string AS queryString,
            hash_fragment AS hashFragment,
            hostname,
            title,
            referrer_url AS referrerUrl,
            referrer_host AS referrerHost,
            country,
            region,
            city,
            browser,
            os,
            os_version AS osVersion,
            device_type AS deviceType,
            language,
            timezone,
            screen_width AS screenWidth,
            screen_height AS screenHeight,
            dirty,
            flush_attempts AS flushAttempts,
            created_at AS createdAt
          FROM buffered_custom_events
          WHERE dirty = 1
          ORDER BY created_at ASC, occurred_at ASC
          LIMIT ?
        `,
        D1_FLUSH_BATCH_SIZE,
      );

      if (visitRows.length === 0 && eventRows.length === 0) {
        return;
      }

      try {
        const statements = [
          ...visitRows.map((row) => this.doEnv.DB.prepare(UPSERT_VISIT_SQL).bind(...visitBindings(row))),
          ...eventRows.map((row) => this.doEnv.DB.prepare(INSERT_CUSTOM_EVENT_SQL).bind(...customEventBindings(row))),
        ];
        if (statements.length > 0) {
          await this.doEnv.DB.batch(statements);
        }
        this.markVisitRowsFlushed(visitRows);
        this.markCustomEventRowsFlushed(eventRows);
      } catch (error) {
        const message = clampString(String(error instanceof Error ? error.message : error), 400);
        this.markVisitRowsFailed(visitRows, message);
        this.markCustomEventRowsFailed(eventRows, message);
        console.error("d1_flush_failed", error);
        return;
      }

      if (visitRows.length < D1_FLUSH_BATCH_SIZE && eventRows.length < D1_FLUSH_BATCH_SIZE) {
        return;
      }
    }
  }

  private markVisitRowsFlushed(rows: BufferedVisitRow[]): void {
    if (rows.length === 0) return;
    const openIds = rows.filter((row) => row.status === "open").map((row) => row.visitId);
    const closedIds = rows.filter((row) => row.status !== "open").map((row) => row.visitId);
    if (openIds.length > 0) {
      this.sqlRun(
        `UPDATE buffered_visits SET dirty = 0, flush_attempts = 0, last_flush_error = NULL WHERE visit_id IN (${openIds.map(() => "?").join(",")})`,
        ...openIds,
      );
    }
    if (closedIds.length > 0) {
      this.sqlRun(
        `DELETE FROM buffered_visits WHERE visit_id IN (${closedIds.map(() => "?").join(",")})`,
        ...closedIds,
      );
    }
  }

  private markCustomEventRowsFlushed(rows: BufferedCustomEventRow[]): void {
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.eventId);
    this.sqlRun(
      `DELETE FROM buffered_custom_events WHERE event_id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
  }

  private markVisitRowsFailed(rows: BufferedVisitRow[], errorMessage: string): void {
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.visitId);
    this.sqlRun(
      `UPDATE buffered_visits SET flush_attempts = flush_attempts + 1, last_flush_error = ? WHERE visit_id IN (${ids.map(() => "?").join(",")})`,
      errorMessage,
      ...ids,
    );
  }

  private markCustomEventRowsFailed(rows: BufferedCustomEventRow[], errorMessage: string): void {
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.eventId);
    this.sqlRun(
      `UPDATE buffered_custom_events SET flush_attempts = flush_attempts + 1, last_flush_error = ? WHERE event_id IN (${ids.map(() => "?").join(",")})`,
      errorMessage,
      ...ids,
    );
  }

  private async cleanupBufferedRows(): Promise<void> {
    const visitCutoff = Date.now() - LOCAL_DEDUPE_RETENTION_MS;
    const eventCutoff = visitCutoff;
    this.sqlRun(
      `
        DELETE FROM buffered_visits
        WHERE dirty = 0
          AND status != 'open'
          AND started_at < ?
      `,
      visitCutoff,
    );
    this.sqlRun(
      `
        DELETE FROM buffered_custom_events
        WHERE dirty = 0
          AND occurred_at < ?
      `,
      eventCutoff,
    );
  }

  private async flushTimeouts(): Promise<void> {
    const now = Date.now();
    const rows = this.sqlAll<{
      visitId: string;
      siteId: string;
      visitorId: string;
      sessionId: string;
      startedAt: number;
      lastActivityAt: number;
      pathname: string;
      country: string;
      browser: string;
      deviceType: string;
    }>(
      `
        SELECT
          visit_id AS visitId,
          site_id AS siteId,
          visitor_id AS visitorId,
          session_id AS sessionId,
          started_at AS startedAt,
          last_activity_at AS lastActivityAt,
          pathname,
          country,
          browser,
          device_type AS deviceType
        FROM buffered_visits
        WHERE status = 'open'
          AND last_activity_at <= ?
        LIMIT ?
      `,
      now - VISIT_TIMEOUT_MS,
      TIMEOUT_FINALIZE_BATCH_SIZE,
    );

    for (const visit of rows) {
      const rowsWritten = this.sqlRun(
        `
          UPDATE buffered_visits
          SET status = 'timeout',
              last_activity_at = ?,
              ended_at = ?,
              finalized_at = ?,
              duration_ms = NULL,
              duration_source = 'timeout',
              exit_reason = 'timeout',
              dirty = 1,
              updated_at = ?
          WHERE site_id = ? AND visit_id = ? AND status = 'open'
        `,
        now,
        now,
        now,
        toUnixSeconds(now),
        visit.siteId,
        visit.visitId,
      );
      if (rowsWritten === 0) continue;
      if (!this.hasOpenVisitsForVisitor(visit.siteId, visit.visitorId)) {
        await this.pushRealtimeRecord({
          id: `leave:${visit.visitId}`,
          eventType: WS_PRESENCE_LEAVE_EVENT,
          eventAt: now,
          pathname: visit.pathname,
          visitorId: visit.visitorId,
          country: visit.country,
          browser: visit.browser,
        });
      }
    }
  }

}
