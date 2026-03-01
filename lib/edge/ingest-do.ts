import { DurableObject } from "cloudflare:workers";
import { UAParser } from "ua-parser-js";
import type {
  Env,
  IngestEnvelopePayload,
  NormalizedEvent,
  TrackerClientPayload,
} from "./types";
import {
  TEN_MINUTES_MS,
  clampString,
  coerceNumber,
  coerceString,
  deriveEuVisitorId,
  deriveSessionId,
  nowEpochSeconds,
  safeHostname,
} from "./utils";

const BUFFER_MAX_SIZE = 20_000;
const BULK_FLUSH_THRESHOLD = 500;
const PENDING_PREFIX = "pending:";
const FLUSH_PAGE_LIMIT = 500;
const D1_BATCH_CHUNK_SIZE = 100;

export class IngestDurableObject extends DurableObject {
  private readonly doState: DurableObjectState;
  private readonly doEnv: Env;
  private buffer: NormalizedEvent[] = [];
  private sockets = new Set<WebSocket>();
  private isFlushing = false;

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
      await this.flushToD1();
      return new Response(JSON.stringify({ ok: true, hasPending: await this.hasPendingItems() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.flushToD1();
    if (await this.hasPendingItems()) {
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

    const event = await this.normalizeEvent(envelope);

    await Promise.all([
      this.appendToBuffer(event),
      this.writeToAnalyticsEngine(event),
      this.pushToWebsocketClients(event),
      this.ensureAlarm(),
    ]);

    if (this.buffer.length >= BULK_FLUSH_THRESHOLD) {
      void this.flushToD1();
    }

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

  private handleSnapshot(url: URL): Response {
    const fromMsRaw = Number(url.searchParams.get("from") || "0");
    const toMsRaw = Number(url.searchParams.get("to") || String(Date.now()));
    const limitRaw = Number(url.searchParams.get("limit") || "5000");

    const fromMs = Number.isFinite(fromMsRaw) ? Math.max(0, Math.floor(fromMsRaw)) : 0;
    const toMs = Number.isFinite(toMsRaw) ? Math.max(fromMs, Math.floor(toMsRaw)) : Date.now();
    const limit = Number.isFinite(limitRaw) ? Math.min(20_000, Math.max(1, Math.floor(limitRaw))) : 5000;

    const payload = {
      ok: true,
      buffered: this.buffer.length,
      data: [] as Array<Record<string, unknown>>,
    };

    // Snapshot is best-effort; keep fast path when memory buffer is available.
    for (let i = this.buffer.length - 1; i >= 0; i -= 1) {
      if (payload.data.length >= limit) break;
      const event = this.buffer[i];
      if (event.eventAt < fromMs || event.eventAt > toMs) continue;
      payload.data.push({
        id: event.id,
        eventType: event.eventType,
        eventAt: event.eventAt,
        pathname: event.pathname,
        queryString: event.queryString,
        hashFragment: event.hashFragment,
        title: event.title,
        hostname: event.hostname,
        referer: event.referer,
        refererHost: event.refererHost,
        visitorId: event.visitorId,
        sessionId: event.sessionId,
        durationMs: event.durationMs,
        country: event.country,
        region: event.region,
        city: event.city,
        browser: event.browser,
        os: event.os,
        deviceType: event.deviceType,
        language: event.language,
        timezone: event.timezone,
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private async normalizeEvent(envelope: IngestEnvelopePayload): Promise<NormalizedEvent> {
    const req = envelope.request;
    const client = envelope.client ?? ({} as TrackerClientPayload);
    const reqHeaders = req.headers ?? {};
    const cf = req.cf ?? {};

    const nowMs = Date.now();
    const eventAt = this.pickTimestamp(client.timestamp, nowMs);
    const receivedAt = this.pickTimestamp(req.receivedAt, nowMs);
    const hourBucket = Math.floor(eventAt / (60 * 60 * 1000));

    const ip = clampString(
      coerceString(reqHeaders["cf-connection-ip"] ?? reqHeaders["x-forwarded-for"] ?? ""),
      80,
    );
    const uaRaw = clampString(coerceString(reqHeaders["user-agent"] ?? ""), 1024);

    const parser = new UAParser(uaRaw);
    const ua = parser.getResult();

    const isEU = Boolean(cf.isEUCountry);
    const sessionWindowMinutes = this.resolveSessionWindowMinutes();

    let visitorId = clampString(coerceString(client.visitorId), 128);
    if (isEU || !visitorId) {
      visitorId = await deriveEuVisitorId({
        ip,
        ua: uaRaw,
        eventAtMs: eventAt,
        secret: this.doEnv.DAILY_SALT_SECRET,
      });
    }

    let sessionId = clampString(coerceString(client.sessionId), 128);
    if (isEU || !sessionId) {
      sessionId = await deriveSessionId({
        visitorId,
        eventAtMs: eventAt,
        sessionWindowMinutes,
      });
    }

    const referer = clampString(
      coerceString(client.referer || reqHeaders.referer || reqHeaders.referrer || ""),
      1000,
    );
    const refererHost = clampString(
      safeHostname(client.refererDetail || referer),
      255,
    );

    const event: NormalizedEvent = {
      id: clampString(coerceString(client.eventId || crypto.randomUUID()), 128),
      eventType: clampString(coerceString(client.eventType || "pageview"), 50),
      eventAt,
      receivedAt,
      hourBucket,
      teamId: clampString(coerceString(client.teamId || "default"), 80),
      siteId: clampString(coerceString(client.siteId || "default"), 80),
      pathname: clampString(coerceString(client.pathname || "/"), 2048),
      queryString: clampString(coerceString(client.query || ""), 2048),
      hashFragment: clampString(coerceString(client.hash || ""), 512),
      hostname: clampString(coerceString(client.hostname || safeHostname(req.url)), 255),
      title: clampString(coerceString(client.title || ""), 1024),
      referer,
      refererHost,
      utmSource: clampString(coerceString(client.utmSource || ""), 255),
      utmMedium: clampString(coerceString(client.utmMedium || ""), 255),
      utmCampaign: clampString(coerceString(client.utmCampaign || ""), 255),
      utmTerm: clampString(coerceString(client.utmTerm || ""), 255),
      utmContent: clampString(coerceString(client.utmContent || ""), 255),
      visitorId,
      sessionId,
      durationMs: coerceNumber(client.durationMs, 0) ?? 0,
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
      timezone: clampString(coerceString(cf.timezone || client.timezone || ""), 128),
      colo: clampString(coerceString(cf.colo ?? ""), 32),
      asOrganization: clampString(coerceString(cf.asOrganization ?? ""), 255),
      uaRaw,
      browser: clampString(coerceString(ua.browser.name ?? ""), 80),
      browserVersion: clampString(coerceString(ua.browser.version ?? ""), 80),
      os: clampString(coerceString(ua.os.name ?? ""), 80),
      osVersion: clampString(coerceString(ua.os.version ?? ""), 80),
      deviceType: clampString(coerceString(ua.device.type ?? "desktop"), 30),
      screenWidth: coerceNumber(client.screenWidth, null),
      screenHeight: coerceNumber(client.screenHeight, null),
      language: clampString(coerceString(client.language ?? ""), 32),
    };

    return event;
  }

  private resolveSessionWindowMinutes(): number {
    const parsed = Number(this.doEnv.SESSION_WINDOW_MINUTES ?? "30");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 30;
    }
    return parsed;
  }

  private pickTimestamp(input: unknown, fallback: number): number {
    const n = coerceNumber(input, fallback);
    if (!n || n <= 0) {
      return fallback;
    }
    return Math.floor(n);
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.doState.storage.getAlarm();
    if (!existing) {
      await this.doState.storage.setAlarm(Date.now() + TEN_MINUTES_MS);
    }
  }

  private async appendToBuffer(event: NormalizedEvent): Promise<void> {
    if (this.buffer.length >= BUFFER_MAX_SIZE) {
      this.buffer.shift();
    }
    this.buffer.push(event);
    await this.doState.storage.put(this.pendingStorageKey(event), event);
  }

  private pendingStorageKey(event: NormalizedEvent): string {
    const ts = String(event.receivedAt).padStart(13, "0");
    return `${PENDING_PREFIX}${ts}:${event.id}`;
  }

  private async hasPendingItems(): Promise<boolean> {
    const rows = await this.doState.storage.list({ prefix: PENDING_PREFIX, limit: 1 });
    return rows.size > 0;
  }

  private async pullPendingEvents(limit: number): Promise<Array<{ key: string; event: NormalizedEvent }>> {
    const rows = await this.doState.storage.list<NormalizedEvent>({
      prefix: PENDING_PREFIX,
      limit,
    });
    const out: Array<{ key: string; event: NormalizedEvent }> = [];
    for (const [key, value] of rows.entries()) {
      if (!value) continue;
      out.push({ key, event: value });
    }
    return out;
  }

  private async writeToAnalyticsEngine(event: NormalizedEvent): Promise<void> {
    if (!this.doEnv.ANALYTICS || typeof this.doEnv.ANALYTICS.writeDataPoint !== "function") {
      return;
    }

    try {
      this.doEnv.ANALYTICS.writeDataPoint({
        indexes: [event.siteId],
        doubles: [
          event.eventAt,
          event.durationMs,
          0,
          event.screenWidth ?? 0,
          event.screenHeight ?? 0,
          event.latitude ?? 0,
          event.longitude ?? 0,
          event.isEU ? 1 : 0,
        ],
        blobs: [
          event.pathname || "/",
          event.queryString || "",
          event.hashFragment || "",
          event.hostname || "",
          event.referer || "",
          event.sessionId || "",
          event.visitorId || "",
          event.browser || "",
          event.browserVersion || "",
          event.os || "",
          event.osVersion || "",
          event.language || "",
          event.colo || "",
          event.eventType,
          event.country || "ZZ",
          event.region || "",
          event.city || "",
          event.timezone || "",
          event.deviceType || "unknown",
          event.refererHost || "direct",
        ],
      });
    } catch (error) {
      console.error("analytics_write_failed", error);
    }
  }

  private async pushToWebsocketClients(event: NormalizedEvent): Promise<void> {
    if (this.sockets.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: "event",
      data: event,
    });

    for (const socket of this.sockets) {
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private async flushToD1(): Promise<void> {
    if (this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    const stmt = this.doEnv.DB.prepare(
      `
      INSERT OR REPLACE INTO pageviews (
        id,
        team_id,
        site_id,
        event_type,
        event_at,
        received_at,
        hour_bucket,
        pathname,
        query_string,
        hash_fragment,
        title,
        hostname,
        referer,
        referer_host,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        visitor_id,
        session_id,
        duration_ms,
        is_eu,
        country,
        region,
        region_code,
        city,
        continent,
        latitude,
        longitude,
        postal_code,
        metro_code,
        timezone,
        colo,
        as_organization,
        ua_raw,
        browser,
        browser_version,
        os,
        os_version,
        device_type,
        screen_width,
        screen_height,
        language,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    try {
      while (true) {
        const pending = await this.pullPendingEvents(FLUSH_PAGE_LIMIT);
        if (pending.length === 0) break;

        const statements = pending.map(({ event }) =>
          stmt.bind(
            event.id,
            event.teamId,
            event.siteId,
            event.eventType,
            event.eventAt,
            event.receivedAt,
            event.hourBucket,
            event.pathname,
            event.queryString,
            event.hashFragment,
            event.title,
            event.hostname,
            event.referer,
            event.refererHost,
            event.utmSource,
            event.utmMedium,
            event.utmCampaign,
            event.utmTerm,
            event.utmContent,
            event.visitorId,
            event.sessionId,
            event.durationMs,
            event.isEU ? 1 : 0,
            event.country,
            event.region,
            event.regionCode,
            event.city,
            event.continent,
            event.latitude,
            event.longitude,
            event.postalCode,
            event.metroCode,
            event.timezone,
            event.colo,
            event.asOrganization,
            event.uaRaw,
            event.browser,
            event.browserVersion,
            event.os,
            event.osVersion,
            event.deviceType,
            event.screenWidth,
            event.screenHeight,
            event.language,
            nowEpochSeconds(),
          ),
        );

        for (let i = 0; i < statements.length; i += D1_BATCH_CHUNK_SIZE) {
          await this.doEnv.DB.batch(statements.slice(i, i + D1_BATCH_CHUNK_SIZE));
        }

        await this.doState.storage.delete(pending.map((x) => x.key));
        const flushedIds = new Set(pending.map((x) => x.event.id));
        this.buffer = this.buffer.filter((event) => !flushedIds.has(event.id));

        if (pending.length < FLUSH_PAGE_LIMIT) break;
      }
    } catch (error) {
      console.error("flush_d1_failed", error);
    } finally {
      this.isFlushing = false;
    }
  }
}
