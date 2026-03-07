import { DurableObject } from "cloudflare:workers";
import { UAParser } from "ua-parser-js";
import type {
  AnalyticsEngineWriteDataPoint,
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
import { isAnalyticsEngineEnabled } from "./flags";
import {
  AE_LAYOUT_VERSION,
  encodeAeContinent,
  encodeAeDeviceType,
  encodeAeRowType,
  toAeCoordinate,
} from "./analytics-engine-layout";
import { readSiteTrackingConfig } from "./site-settings-store";
import {
  TEN_MINUTES_MS,
  clampString,
  coerceNumber,
  coerceString,
  deriveEuVisitorId,
  safeHostname,
} from "./utils";

const SNAPSHOT_PREFIX = "snapshot:";
const OPEN_VISIT_PREFIX = "open:";
const SESSION_PREFIX = "session:";
const SNAPSHOT_QUERY_SCAN_LIMIT = 20_000;
const SNAPSHOT_BUFFER_RETENTION_MS = 30 * 60 * 1000;
const ACTIVE_NOW_WINDOW_MS = 5 * 60 * 1000;
const VISIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const WS_SNAPSHOT_EVENT_LIMIT = 200;

function toAeRegionValue(country: string, regionCode: string, region: string): string {
  const normalizedCountry = country.trim().toUpperCase();
  const normalizedRegionCode = regionCode.trim() || region.trim();
  const normalizedRegion = region.trim();
  if (!normalizedCountry && !normalizedRegionCode && !normalizedRegion) {
    return "";
  }
  return [normalizedCountry, normalizedRegionCode, normalizedRegion].join("::");
}

function toAeCityValue(country: string, regionCode: string, region: string, city: string): string {
  const normalizedCountry = country.trim().toUpperCase();
  const normalizedRegionCode = regionCode.trim() || region.trim();
  const normalizedRegion = region.trim();
  const normalizedCity = city.trim();
  if (!normalizedCountry && !normalizedRegionCode && !normalizedRegion && !normalizedCity) {
    return "";
  }
  return [normalizedCountry, normalizedRegionCode, normalizedRegion, normalizedCity].join("::");
}

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

interface StoredSessionState {
  sessionId: string;
  lastSeenAt: number;
  openVisitCount: number;
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
  private sockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.doState = state;
    this.doEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
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
      return jsonResponse({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.flushTimeouts();
    await this.cleanupSnapshotWindow();
    if ((await this.hasOpenVisits()) || (await this.hasSnapshotItems())) {
      await this.doState.storage.setAlarm(Date.now() + TEN_MINUTES_MS);
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
      ? Math.min(20_000, Math.max(1, Math.floor(limitRaw)))
      : 5000;

    const rows = await this.doState.storage.list<RealtimeSnapshotRecord>({
      prefix: SNAPSHOT_PREFIX,
      reverse: true,
      limit: SNAPSHOT_QUERY_SCAN_LIMIT,
    });

    const payload = {
      ok: true,
      buffered: rows.size,
      data: [] as Array<Record<string, unknown>>,
    };

    for (const event of rows.values()) {
      if (!event) continue;
      if (payload.data.length >= limit) break;
      if (event.eventAt < fromMs || event.eventAt > toMs) continue;
      payload.data.push(toRealtimePayload(event));
    }

    return jsonResponse(payload);
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

    const visitId = clampString(coerceString(client.visitId), 128);
    const referrerUrl = clampString(coerceString(client.referrerUrl), 2000);
    const contextBase = {
      siteId,
      visitId,
      visitorId,
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
      screenWidth: coerceNumber(client.screenWidth, null),
      screenHeight: coerceNumber(client.screenHeight, null),
      language: clampString(coerceString(client.language || ""), 120),
    };

    const kind = clampString(coerceString(client.kind), 40) as TrackerPayloadKind;
    if (kind === "visit_start") {
      if (!visitId) return null;
      const sessionId = await this.resolveSessionId(visitorId, eventAt);
      return {
        kind: "visit_start",
        receivedAt,
        sessionId,
        ...contextBase,
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

    await this.touchSession(record.visitorId, record.sessionId, record.startedAt, 1);

    const openVisit: StoredOpenVisit = {
      ...record,
      lastActivityAt: record.startedAt,
    };

    await this.doState.storage.put(this.openVisitStorageKey(record.visitId), openVisit);
    this.writeVisitStartToAe(record);
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

    const result = await this.doEnv.DB.prepare(
      `
        UPDATE visits
        SET status = 'finalized',
            last_activity_at = ?,
            ended_at = ?,
            finalized_at = ?,
            duration_ms = ?,
            duration_source = ?,
            exit_reason = ?,
            updated_at = unixepoch()
        WHERE site_id = ? AND visit_id = ? AND status = 'open'
      `,
    )
      .bind(
        finalizedAt,
        finalizedAt,
        finalizedAt,
        durationMs,
        record.durationSource,
        record.exitReason,
        record.siteId,
        record.visitId,
      )
      .run();
    if (Number(result.meta?.changes ?? 0) === 0) {
      return;
    }

    await this.touchSession(record.visitorId, record.sessionId, finalizedAt, -1);
    await this.doState.storage.delete(this.openVisitStorageKey(record.visitId));
    this.writeVisitFinalizeToAe({ ...record, finalizedAt, durationMs });
  }

  private async handleCustomEvent(record: NormalizedCustomEvent): Promise<void> {
    const inserted = await this.insertCustomEvent(record);
    if (!inserted) {
      return;
    }
    await this.updateOpenVisitActivity(record.visitId, record.eventAt);
    await this.touchSession(record.visitorId, record.sessionId, record.eventAt, 0);
    this.writeCustomEventToAe(record);
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
    const openVisit = await this.doState.storage.get<StoredOpenVisit>(this.openVisitStorageKey(visitId));
    if (openVisit) return openVisit;

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
    return (await this.doEnv.DB.prepare(
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
        FROM visits
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
    )
      .bind(siteId, visitId)
      .first<VisitRow>()) ?? null;
  }

  private async insertVisit(record: NormalizedVisitStart): Promise<boolean> {
    const result = await this.doEnv.DB.prepare(
      `
        INSERT OR IGNORE INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
          pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          is_eu, country, region, region_code, city, continent, latitude, longitude,
          postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
          os, os_version, device_type, screen_width, screen_height, language, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `,
    )
      .bind(
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
      )
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  private async insertCustomEvent(record: NormalizedCustomEvent): Promise<boolean> {
    const result = await this.doEnv.DB.prepare(
      `
        INSERT OR IGNORE INTO custom_events (
          event_id, site_id, visit_id, visitor_id, session_id, occurred_at, event_name, event_data_json,
          pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
          country, region, city, browser, os, os_version, device_type, language, timezone,
          screen_width, screen_height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
    )
      .bind(
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
      )
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  private writeVisitStartToAe(record: NormalizedVisitStart): void {
    this.writeToAe({
      indexes: [record.siteId],
      blobs: [
        record.visitId,
        record.visitorId,
        record.sessionId,
        record.pathname,
        record.queryString,
        record.hashFragment,
        record.hostname,
        record.referrerUrl,
        record.referrerHost,
        record.country,
        toAeRegionValue(record.country, record.regionCode, record.region),
        toAeCityValue(record.country, record.regionCode, record.region, record.city),
        record.browser,
        record.os,
        record.osVersion,
        record.language,
        record.timezone,
        record.asOrganization,
        record.browserVersion,
        record.title,
      ],
      doubles: [
        record.startedAt,
        -1,
        AE_LAYOUT_VERSION,
        record.screenWidth ?? 0,
        record.screenHeight ?? 0,
        toAeCoordinate(record.latitude),
        toAeCoordinate(record.longitude),
        encodeAeRowType(record.kind),
        encodeAeDeviceType(record.deviceType),
        encodeAeContinent(record.continent),
        record.startedAt,
        record.isEU ? 1 : 0,
      ],
    });
  }

  private writeVisitFinalizeToAe(record: NormalizedVisitFinalize & { durationMs: number }): void {
    this.writeToAe({
      indexes: [record.siteId],
      blobs: [
        record.visitId,
        record.visitorId,
        record.sessionId,
        "",
        "",
        "",
        "",
        "",
        "",
        record.country,
        "",
        "",
        record.browser,
        "",
        "",
        "",
        "",
        "",
        "",
        `${record.exitReason}|${record.durationSource}`,
      ],
      doubles: [
        record.finalizedAt,
        record.durationMs,
        AE_LAYOUT_VERSION,
        0,
        0,
        toAeCoordinate(null),
        toAeCoordinate(null),
        encodeAeRowType(record.kind),
        encodeAeDeviceType(record.deviceType),
        0,
        record.startedAt,
        0,
      ],
    });
  }

  private writeCustomEventToAe(record: NormalizedCustomEvent): void {
    this.writeToAe({
      indexes: [record.siteId],
      blobs: [
        record.visitId,
        record.visitorId,
        record.sessionId,
        record.pathname,
        record.queryString,
        record.hashFragment,
        record.hostname,
        record.referrerUrl,
        record.referrerHost,
        record.country,
        toAeRegionValue(record.country, record.regionCode, record.region),
        toAeCityValue(record.country, record.regionCode, record.region, record.city),
        record.browser,
        record.os,
        record.osVersion,
        record.language,
        record.timezone,
        record.asOrganization,
        record.browserVersion,
        record.eventName,
      ],
      doubles: [
        record.eventAt,
        -1,
        AE_LAYOUT_VERSION,
        record.screenWidth ?? 0,
        record.screenHeight ?? 0,
        toAeCoordinate(record.latitude),
        toAeCoordinate(record.longitude),
        encodeAeRowType(record.kind),
        encodeAeDeviceType(record.deviceType),
        encodeAeContinent(record.continent),
        record.startedAt,
        record.isEU ? 1 : 0,
      ],
    });
  }

  private writeToAe(data: AnalyticsEngineWriteDataPoint): void {
    const analytics = this.doEnv.ANALYTICS;
    if (!isAnalyticsEngineEnabled(this.doEnv) || !analytics) return;
    try {
      analytics.writeDataPoint(data);
    } catch (error) {
      console.error("analytics_engine_write_failed", error);
    }
  }
  private async resolveSessionId(visitorId: string, eventAt: number): Promise<string> {
    const sessionWindowMs = this.resolveSessionWindowMinutes() * 60 * 1000;
    const existing = await this.doState.storage.get<StoredSessionState>(this.sessionStorageKey(visitorId));
    if (existing && (existing.openVisitCount > 0 || eventAt - existing.lastSeenAt <= sessionWindowMs)) {
      return existing.sessionId;
    }
    return crypto.randomUUID();
  }

  private async touchSession(
    visitorId: string,
    sessionId: string,
    eventAt: number,
    openVisitDelta: number,
  ): Promise<void> {
    const key = this.sessionStorageKey(visitorId);
    const existing = await this.doState.storage.get<StoredSessionState>(key);
    await this.doState.storage.put(key, {
      sessionId,
      lastSeenAt: Math.max(eventAt, existing?.lastSeenAt ?? 0),
      openVisitCount: Math.max(0, (existing?.openVisitCount ?? 0) + openVisitDelta),
    } satisfies StoredSessionState);
  }

  private async updateOpenVisitActivity(visitId: string, eventAt: number): Promise<void> {
    const key = this.openVisitStorageKey(visitId);
    const visit = await this.doState.storage.get<StoredOpenVisit>(key);
    if (!visit) return;
    visit.lastActivityAt = Math.max(visit.lastActivityAt, eventAt);
    await this.doState.storage.put(key, visit);
  }

  private openVisitStorageKey(visitId: string): string {
    return `${OPEN_VISIT_PREFIX}${visitId}`;
  }

  private sessionStorageKey(visitorId: string): string {
    return `${SESSION_PREFIX}${visitorId}`;
  }

  private snapshotStorageKey(record: RealtimeSnapshotRecord): string {
    const ts = String(record.eventAt).padStart(16, "0");
    return `${SNAPSHOT_PREFIX}${ts}:${record.id}`;
  }

  private async pushRealtimeRecord(record: RealtimeSnapshotRecord): Promise<void> {
    await this.doState.storage.put(this.snapshotStorageKey(record), record);
    await this.pushToWebsocketClients(record);
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.doState.storage.getAlarm();
    if (!existing) {
      await this.doState.storage.setAlarm(Date.now() + TEN_MINUTES_MS);
    }
  }

  private async hasOpenVisits(): Promise<boolean> {
    const rows = await this.doState.storage.list({ prefix: OPEN_VISIT_PREFIX, limit: 1 });
    return rows.size > 0;
  }

  private async hasSnapshotItems(): Promise<boolean> {
    const rows = await this.doState.storage.list({ prefix: SNAPSHOT_PREFIX, limit: 1 });
    return rows.size > 0;
  }

  private async pushInitialSnapshotToSocket(socket: WebSocket): Promise<void> {
    try {
      const rows = await this.doState.storage.list<RealtimeSnapshotRecord>({
        prefix: SNAPSHOT_PREFIX,
        reverse: true,
        limit: SNAPSHOT_QUERY_SCAN_LIMIT,
      });

      const events: Array<Record<string, unknown>> = [];
      const activeVisitors = new Set<string>();
      const cutoffMs = Date.now() - ACTIVE_NOW_WINDOW_MS;

      for (const record of rows.values()) {
        if (!record) continue;
        if (events.length < WS_SNAPSHOT_EVENT_LIMIT) {
          events.push(toRealtimePayload(record));
        }
        if (record.eventAt >= cutoffMs && record.visitorId) {
          activeVisitors.add(record.visitorId);
        }
      }

      socket.send(JSON.stringify({
        type: "snapshot",
        data: {
          activeNow: activeVisitors.size,
          events,
          buffered: rows.size,
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

  private async cleanupSnapshotWindow(): Promise<void> {
    const cutoffKey = `${SNAPSHOT_PREFIX}${String(Date.now() - SNAPSHOT_BUFFER_RETENTION_MS).padStart(16, "0")}:`;
    while (true) {
      const rows = await this.doState.storage.list({
        prefix: SNAPSHOT_PREFIX,
        end: cutoffKey,
        limit: 512,
      });
      if (rows.size === 0) return;
      await this.doState.storage.delete(Array.from(rows.keys()));
      if (rows.size < 512) return;
    }
  }

  private async flushTimeouts(): Promise<void> {
    const now = Date.now();
    const rows = await this.doState.storage.list<StoredOpenVisit>({
      prefix: OPEN_VISIT_PREFIX,
      limit: 2048,
    });

    for (const [key, visit] of rows.entries()) {
      if (!visit) continue;
      if (now - visit.lastActivityAt < VISIT_TIMEOUT_MS) continue;

      const existing = await this.readVisitRow(visit.siteId, visit.visitId);
      if (!existing || existing.status !== "open") {
        await this.doState.storage.delete(key);
        continue;
      }

      await this.doEnv.DB.prepare(
        `
          UPDATE visits
          SET status = 'timeout',
              last_activity_at = ?,
              ended_at = ?,
              finalized_at = ?,
              duration_ms = NULL,
              duration_source = 'timeout',
              exit_reason = 'timeout',
              updated_at = unixepoch()
          WHERE site_id = ? AND visit_id = ? AND status = 'open'
        `,
      )
        .bind(now, now, now, visit.siteId, visit.visitId)
        .run();

      await this.touchSession(visit.visitorId, visit.sessionId, now, -1);
      await this.doState.storage.delete(key);
      this.writeVisitFinalizeToAe({
        kind: "visit_finalize",
        siteId: visit.siteId,
        visitId: visit.visitId,
        visitorId: visit.visitorId,
        sessionId: visit.sessionId,
        startedAt: visit.startedAt,
        finalizedAt: now,
        receivedAt: now,
        durationMs: -1,
        durationSource: "timeout",
        exitReason: "timeout",
        country: visit.country,
        browser: visit.browser,
        deviceType: visit.deviceType,
      });
    }
  }

  private resolveSessionWindowMinutes(): number {
    const raw = Number(this.doEnv.SESSION_WINDOW_MINUTES || "30");
    if (!Number.isFinite(raw) || raw <= 0) return 30;
    return Math.max(1, Math.min(24 * 60, Math.floor(raw)));
  }
}
