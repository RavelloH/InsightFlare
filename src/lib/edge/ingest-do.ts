import { DurableObject } from "cloudflare:workers";

import {
  type TrafficVisitSnapshot,
  writeEventAnalyticsPoint,
  writeTrafficPageviewFact,
  writeTrafficSessionEndedFact,
  writeTrafficVisitFinalizedFact,
} from "./analytics-engine/index";
import { advanceAnalyticsSession } from "./analytics-session-state";
import {
  attachPerformanceToVisit as attachPerformanceToVisitInBufferStore,
  findRecentVisitorSession as findRecentVisitorSessionInBufferStore,
  getVisitContext as getVisitContextFromBufferStore,
  insertBufferedCustomEvent as insertBufferedCustomEventInBufferStore,
  insertBufferedVisitRow as insertBufferedVisitRowInBufferStore,
  insertCustomEvent as insertCustomEventInBufferStore,
  insertVisit as insertVisitInBufferStore,
  readPersistedVisitRow as readPersistedVisitRowFromBufferStore,
  updateOpenVisitActivity as updateOpenVisitActivityInBufferStore,
} from "./ingest-buffer-store";
import {
  ACTIVE_NOW_WINDOW_MS,
  D1_FLUSH_INTERVAL_MS,
  HIDDEN_LEAVE_GRACE_MS,
  VISIT_TIMEOUT_MS,
  WS_PRESENCE_LEAVE_EVENT,
} from "./ingest-constants";
import { handleIngestDiagnostic } from "./ingest-diagnostic";
import {
  cleanupBufferedRows as cleanupBufferedRowsInFlushStore,
  flushPendingToD1 as flushPendingToD1InFlushStore,
  flushTimeouts as flushTimeoutsInFlushStore,
} from "./ingest-flush";
import { jsonResponse, type RealtimeSnapshotRecord } from "./ingest-normalize";
import {
  pushInitialRealtimeSnapshot,
  pushRealtimeRecordToSockets,
  readActiveRealtimeVisits,
  readRecentRealtimeEvents,
  snapshotQueryParams,
} from "./ingest-realtime";
import { normalizeIngestRecord } from "./ingest-record-normalize";
import { getEarliestDueWork } from "./ingest-scheduler";
import { initializeIngestSqlSchema } from "./ingest-schema";
import type { SqlBinding } from "./ingest-sql";
import { toUnixSeconds } from "./ingest-time";
import type {
  BufferedCustomEventInput,
  BufferedVisitRow,
  NormalizeResult,
  RecentVisitorSession,
  StoredOpenVisit,
} from "./ingest-types";
import { instrumentEnv } from "./observability-bindings";
import {
  createInvocationLogger,
  currentInvocationLogger,
  errorLogData,
  type InvocationLogger,
  runWithInvocationLogger,
} from "./observability-logger";
import { SITE_PK_FROM_SITE_ID_SQL } from "./site-identity-sql";
import type {
  Env,
  IngestEnvelopePayload,
  NormalizedCustomEvent,
  NormalizedIdentify,
  NormalizedLeave,
  NormalizedPageview,
  NormalizedVisibility,
  TrackerPerformancePayload,
} from "./types";
import { resolveSessionWindowMinutes } from "./utils";

function pageviewTrafficSnapshot(
  record: NormalizedPageview,
  visitId = record.visitId,
  startedAt = record.startedAt,
): TrafficVisitSnapshot {
  return {
    siteId: record.siteId,
    visitId,
    visitorId: record.visitorId,
    sessionId: record.sessionId,
    startedAt,
    pathname: record.pathname,
    queryString: record.queryString,
    hashFragment: record.hashFragment,
    title: record.title,
    hostname: record.hostname,
    referrerUrl: record.referrerUrl,
    referrerHost: record.referrerHost,
    utmSource: record.utmSource,
    utmMedium: record.utmMedium,
    utmCampaign: record.utmCampaign,
    utmTerm: record.utmTerm,
    utmContent: record.utmContent,
    region: record.region,
    city: record.city,
    continent: record.continent,
    country: record.country,
    regionCode: record.regionCode,
    postalCode: record.postalCode,
    metroCode: record.metroCode,
    timezone: record.timezone,
    asOrganization: record.asOrganization,
    browser: record.browser,
    browserVersion: record.browserVersion,
    os: record.os,
    osVersion: record.osVersion,
    deviceType: record.deviceType,
    language: record.language,
    latitude: record.latitude,
    longitude: record.longitude,
    screenWidth: record.screenWidth,
    screenHeight: record.screenHeight,
  };
}

export class IngestDurableObject extends DurableObject {
  private readonly doState: DurableObjectState;
  private readonly doEnv: Env;
  private readonly schemaReady: Promise<void>;
  private readonly dictionaryIds = new Map<string, number>();
  private readonly sitePks = new Map<string, number>();
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
    const url = new URL(request.url);
    const logger = createInvocationLogger({
      source: "do",
      trigger: "request",
    });
    logger.info("do.request.started");

    try {
      return await runWithInvocationLogger(logger, async () => {
        await logger.measure("do.schema_ready", () => this.schemaReady);
        const response = await this.handleRequest(request, url, logger);
        logger.setRequest({
          route: url.pathname,
          method: request.method,
          status: response.status,
          outcome: response.status >= 400 ? "error" : "ok",
        });
        return response;
      });
    } catch (error) {
      logger.error("do.request.unhandled_error", errorLogData(error));
      logger.setRequest({
        route: url.pathname,
        method: request.method,
        status: 500,
        outcome: "error",
      });
      throw error;
    } finally {
      logger.info("do.request.completed");
      logger.emit();
    }
  }

  private async handleRequest(
    request: Request,
    url: URL,
    logger: InvocationLogger,
  ): Promise<Response> {
    if (url.pathname === "/ws") {
      return this.handleWebSocket(request, url, logger);
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      return this.handleIngest(request, logger);
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      return this.handleSnapshot(url, logger);
    }

    if (url.pathname === "/active" && request.method === "GET") {
      return this.handleActive(logger);
    }

    if (url.pathname === "/diagnostic" && request.method === "GET") {
      return this.handleDiagnostic(logger);
    }

    if (url.pathname === "/reconcile" && request.method === "POST") {
      logger.info("do.alarm.reconcile_internal_started");
      await this.reconcileAlarm(logger);
      logger.info("do.alarm.reconcile_internal_completed");
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/flush" && request.method === "POST") {
      const force =
        this.doEnv.INSIGHTFLARE_E2E === "1" &&
        url.searchParams.get("force") === "1";
      logger.info("do.flush.manual_started");
      await this.runMaintenance(logger, force);
      await this.reconcileAlarm(logger, true);
      logger.info("do.flush.manual_completed");
      return jsonResponse({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(alarmInfo?: {
    retryCount?: number;
    isRetry?: boolean;
  }): Promise<void> {
    const logger = createInvocationLogger({ source: "do", trigger: "alarm" });
    logger.info("do.alarm.started");
    try {
      await runWithInvocationLogger(logger, async () => {
        await logger.measure("do.schema_ready", () => this.schemaReady);
        logger.info("do.alarm.invocation", {
          retryCount: alarmInfo?.retryCount ?? 0,
          isRetry: Boolean(alarmInfo?.isRetry),
        });
        await logger.measure("do.maintenance", () =>
          this.runMaintenance(logger),
        );
        await this.reconcileAlarm(logger, true, alarmInfo);
      });
    } catch (error) {
      try {
        // The alarm platform retries a rejected invocation, but the current
        // alarm may already have been consumed.  Reconcile the remaining
        // backlog as a bounded, one-shot retry before preserving the original
        // maintenance failure for the platform.
        await runWithInvocationLogger(logger, () =>
          this.reconcileAlarm(logger, true, alarmInfo, true),
        );
      } catch (reconcileError) {
        // A storage failure while scheduling recovery must not hide the
        // maintenance error that caused this invocation to fail.
        logger.error("do.alarm.reconcile_failed", errorLogData(reconcileError));
      }
      logger.error("do.alarm.failed", errorLogData(error));
      throw error;
    } finally {
      logger.info("do.alarm.completed");
      logger.emit();
    }
  }

  private async handleIngest(
    request: Request,
    logger: InvocationLogger,
  ): Promise<Response> {
    let envelope: IngestEnvelopePayload;
    try {
      envelope = (await logger.measure("do.request_body_read", () =>
        request.json(),
      )) as IngestEnvelopePayload;
    } catch {
      logger.warn("do.ingest.bad_request");
      return new Response("Bad Request", { status: 400 });
    }

    const traceId = envelope.trace?.id || "";
    logger.setTraceId(traceId || undefined);
    logger.info("do.ingest.received");

    const normalized = await logger.measure("do.ingest.normalize", () =>
      this.normalizeRecord(envelope),
    );
    const record = normalized.record;
    if (!record) {
      if (
        normalized.reason === "waiting_for_visit" &&
        normalized.detail?.buffered === true
      ) {
        await logger.measure("do.alarm.reconcile_waiting", () =>
          this.reconcileAlarm(logger),
        );
      }
      logger.warn(`do.ingest.ignored.${normalized.reason || "unknown"}`);
      return new Response(`ignored:${normalized.reason || "unknown"}`, {
        status: 202,
      });
    }

    if (record.kind === "pageview") {
      await logger.measure("do.ingest.pageview", () =>
        this.handlePageview(record, logger),
      );
    } else if (record.kind === "leave") {
      await logger.measure("do.ingest.leave", () =>
        this.handleLeave(record, logger),
      );
    } else if (record.kind === "visibility") {
      await logger.measure("do.ingest.visibility", () =>
        this.handleVisibility(record, logger),
      );
    } else if (record.kind === "identify") {
      await logger.measure("do.ingest.identify", () =>
        this.handleIdentify(record, logger),
      );
    } else {
      await logger.measure("do.ingest.custom_event", () =>
        this.handleCustomEvent(record, logger),
      );
    }

    await logger.measure("do.alarm.reconcile", () =>
      this.reconcileAlarm(logger),
    );
    logger.info("do.ingest.completed");
    return new Response("ok", { status: 202 });
  }

  private async handleWebSocket(
    request: Request,
    _url: URL,
    logger: InvocationLogger,
  ): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    // Worker 层已验证 Session，此处不再需要额外的 token 验证
    // 如果需要额外的安全层，可以在这里添加站点权限检查

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);
    const connectedAt = performance.now();
    logger.info("do.websocket.connected");
    if (
      await logger.measure("do.websocket.initial_snapshot", () =>
        this.pushInitialSnapshotToSocket(server, logger),
      )
    ) {
      logger.info("do.websocket.snapshot_sent");
    } else {
      logger.error("do.websocket.snapshot_failed");
    }

    server.addEventListener("close", (event) => {
      this.sockets.delete(server);
      this.emitWebSocketLifecycle("do.websocket.closed", connectedAt, {
        code: event.code,
      });
    });
    server.addEventListener("error", () => {
      this.sockets.delete(server);
      this.emitWebSocketLifecycle("do.websocket.error", connectedAt);
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

  private emitWebSocketLifecycle(
    event: "do.websocket.closed" | "do.websocket.error",
    connectedAt: number,
    data?: { code: number },
  ): void {
    const logger = createInvocationLogger({ source: "do", trigger: "request" });
    logger.setRequest({
      route: "/ws",
      method: "WEBSOCKET",
      status: event === "do.websocket.error" ? 500 : 101,
      outcome: event === "do.websocket.error" ? "error" : "ok",
    });
    logger.setPerformance({
      webSocketDurationMs: Math.max(
        0,
        Math.round(performance.now() - connectedAt),
      ),
    });
    if (event === "do.websocket.error") {
      logger.error(event);
    } else {
      logger.info(event, data);
    }
    logger.emit();
  }

  private async handleSnapshot(
    url: URL,
    logger: InvocationLogger,
  ): Promise<Response> {
    const { fromMs, toMs, limit } = snapshotQueryParams(url);
    const cutoffMs = Date.now() - ACTIVE_NOW_WINDOW_MS;
    const activeNow = await logger.measure(
      "do.snapshot.active_count",
      async () =>
        this.measuredSqlOne<{ count: number }>(
          logger,
          `
        SELECT count(DISTINCT visitor_id) AS count
        FROM buffered_visits
        WHERE status = 'open'
          AND last_activity_at >= ?
      `,
          cutoffMs,
        )?.count ?? 0,
    );

    const events = await logger.measure(
      "do.snapshot.realtime_events",
      async () =>
        readRecentRealtimeEvents(
          {
            sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
              this.measuredSqlAll<T>(logger, query, ...bindings),
          },
          fromMs,
          toMs,
          limit,
        ),
    );
    const visits = await logger.measure(
      "do.snapshot.realtime_visits",
      async () =>
        readActiveRealtimeVisits(
          {
            sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
              this.measuredSqlAll<T>(logger, query, ...bindings),
          },
          cutoffMs,
        ),
    );

    return jsonResponse({
      ok: true,
      buffered: 0,
      activeNow,
      events,
      visits,
    });
  }

  private async handleActive(logger: InvocationLogger): Promise<Response> {
    const cutoffMs = Date.now() - ACTIVE_NOW_WINDOW_MS;
    const activeNow = await logger.measure(
      "do.active.count",
      async () =>
        this.measuredSqlOne<{ count: number }>(
          logger,
          `
        SELECT count(DISTINCT visitor_id) AS count
        FROM buffered_visits
        WHERE status = 'open'
          AND last_activity_at >= ?
      `,
          cutoffMs,
        )?.count ?? 0,
    );

    return jsonResponse({ ok: true, activeNow });
  }

  private async handleDiagnostic(logger: InvocationLogger): Promise<Response> {
    return logger.measure("do.diagnostic", () =>
      handleIngestDiagnostic({
        sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
          this.measuredSqlAll<T>(logger, query, ...bindings),
        sqlOne: <T>(query: string, ...bindings: SqlBinding[]) =>
          this.measuredSqlOne<T>(logger, query, ...bindings),
        getAlarm: () => this.doState.storage.getAlarm(),
      }),
    );
  }

  private initializeSqlSchema(): void {
    initializeIngestSqlSchema(this.doState.storage.sql);
  }

  private sqlAll<T>(query: string, ...bindings: SqlBinding[]): T[] {
    const logger = currentInvocationLogger();
    if (logger) return this.measuredSqlAll<T>(logger, query, ...bindings);
    return this.rawSqlAll<T>(query, ...bindings);
  }

  private rawSqlAll<T>(query: string, ...bindings: SqlBinding[]): T[] {
    return this.doState.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  private sqlOne<T>(query: string, ...bindings: SqlBinding[]): T | null {
    const rows = this.sqlAll<T>(query, ...bindings);
    return rows[0] ?? null;
  }

  private sqlRun(query: string, ...bindings: SqlBinding[]): number {
    const logger = currentInvocationLogger();
    if (logger) return this.measuredSqlRun(logger, query, ...bindings);
    return this.rawSqlRun(query, ...bindings);
  }

  private rawSqlRun(query: string, ...bindings: SqlBinding[]): number {
    return this.doState.storage.sql.exec(query, ...bindings).rowsWritten;
  }

  private measuredSqlAll<T>(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): T[] {
    const span = logger.startSpan("do_sql.all", {
      statementKind:
        query
          .trimStart()
          .match(/^([a-z]+)/i)?.[1]
          ?.toLowerCase() || "other",
      bindingCount: bindings.length,
    });
    logger.increment("doSqlStatements");
    try {
      const rows = this.rawSqlAll<T>(query, ...bindings);
      logger.increment("doSqlRowsRead", rows.length);
      span.end({ rowCount: rows.length });
      return rows;
    } catch (error) {
      span.fail(errorLogData(error));
      throw error;
    }
  }

  private measuredSqlOne<T>(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): T | null {
    return this.measuredSqlAll<T>(logger, query, ...bindings)[0] ?? null;
  }

  private measuredSqlRun(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): number {
    const span = logger.startSpan("do_sql.run", {
      statementKind:
        query
          .trimStart()
          .match(/^([a-z]+)/i)?.[1]
          ?.toLowerCase() || "other",
      bindingCount: bindings.length,
    });
    logger.increment("doSqlStatements");
    try {
      const rowsWritten = this.rawSqlRun(query, ...bindings);
      logger.increment("doSqlRowsWritten", rowsWritten);
      span.end({ rowsWritten });
      return rowsWritten;
    } catch (error) {
      span.fail(errorLogData(error));
      throw error;
    }
  }

  private bufferStoreContext() {
    return {
      env: this.doEnv,
      sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
        this.sqlAll<T>(query, ...bindings),
      sqlOne: <T>(query: string, ...bindings: SqlBinding[]) =>
        this.sqlOne<T>(query, ...bindings),
      sqlRun: (query: string, ...bindings: SqlBinding[]) =>
        this.sqlRun(query, ...bindings),
    };
  }

  private async normalizeRecord(
    envelope: IngestEnvelopePayload,
  ): Promise<NormalizeResult> {
    return normalizeIngestRecord(envelope, {
      env: this.doEnv,
      getVisitContext: this.getVisitContext.bind(this),
      findRecentVisitorSession: this.findRecentVisitorSession.bind(this),
      insertBufferedCustomEvent: this.insertBufferedCustomEvent.bind(this),
    });
  }

  private async handlePageview(
    record: NormalizedPageview,
    logger: InvocationLogger,
  ): Promise<void> {
    const now = toUnixSeconds(record.receivedAt);
    const previousVisit =
      record.previousVisitId && record.previousVisitStartedAt !== null
        ? this.readTrafficVisitSnapshot(record.siteId, record.previousVisitId)
        : null;

    if (record.previousVisitId && record.previousVisitStartedAt !== null) {
      const flushDueAt = record.receivedAt + D1_FLUSH_INTERVAL_MS;
      const durationMs = Math.max(
        0,
        record.startedAt - record.previousVisitStartedAt,
      );
      const closedPrevious = this.sqlRun(
        `
          UPDATE buffered_visits
          SET status = 'complete',
              last_activity_at = ?,
              hidden_at = NULL,
              ended_at = ?,
              finalized_at = ?,
              duration_ms = ?,
              duration_source = 'server',
              dirty = 1,
              buffer_revision = buffer_revision + 1,
              flush_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              next_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              updated_at = ?
          WHERE visit_id = ? AND status IN ('open', 'hidden_pending')
        `,
        record.startedAt,
        record.startedAt,
        record.startedAt,
        durationMs,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        now,
        record.previousVisitId,
      );
      if (closedPrevious > 0) {
        writeTrafficVisitFinalizedFact(
          this.doEnv,
          {
            visit:
              previousVisit ??
              pageviewTrafficSnapshot(
                record,
                record.previousVisitId,
                record.previousVisitStartedAt,
              ),
            receivedAt: record.receivedAt,
            endedAt: record.startedAt,
            durationMs,
            durationSource: "server",
            exitReason: "route_change",
          },
          logger,
        );
        logger.info("do.ingest.previous_visit_closed");
      }
    }

    const inserted = await this.insertVisit(record);
    if (!inserted) {
      logger.info("do.ingest.pageview_duplicate");
      return;
    }
    logger.info("do.ingest.pageview_buffered");
    let sessionPageIndex = 1;
    try {
      const sessionState = advanceAnalyticsSession(this.bufferStoreContext(), {
        siteId: record.siteId,
        sessionId: record.sessionId,
        visitorId: record.visitorId,
        startedAt: record.startedAt,
        pathname: record.pathname,
        visitId: record.visitId,
        sessionWindowMs: resolveSessionWindowMinutes(this.doEnv) * 60 * 1000,
      });
      sessionPageIndex = sessionState.pageCount;
    } catch {
      logger.warn("do.ingest.session_state_failed");
    }
    writeTrafficPageviewFact(
      this.doEnv,
      { record, sessionPageIndex, sessionViewCount: sessionPageIndex },
      logger,
    );
    await this.advanceWaitingCustomEvents(record.siteId, record.visitId);
    await this.pushRealtimeRecord({
      id: record.visitId,
      eventType: "visit",
      eventKind: "pageview",
      eventAt: record.startedAt,
      siteId: record.siteId,
      traceId: record.traceId,
      receivedAt: record.receivedAt,
      visitId: record.visitId,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      previousVisitId: record.previousVisitId,
      previousVisitStartedAt: record.previousVisitStartedAt,
      pathname: record.pathname,
      queryString: record.queryString,
      hash: record.hashFragment,
      title: record.title,
      hostname: record.hostname,
      referrerUrl: record.referrerUrl,
      referrerHost: record.referrerHost,
      utmSource: record.utmSource,
      utmMedium: record.utmMedium,
      utmCampaign: record.utmCampaign,
      utmTerm: record.utmTerm,
      utmContent: record.utmContent,
      visitorId: record.visitorId,
      userId: record.userId,
      userName: record.userName,
      isEU: record.isEU,
      country: record.country,
      region: record.region,
      regionCode: record.regionCode,
      city: record.city,
      continent: record.continent,
      postalCode: record.postalCode,
      metroCode: record.metroCode,
      timezone: record.timezone,
      organization: record.asOrganization,
      uaRaw: record.uaRaw,
      browser: record.browser,
      browserVersion: record.browserVersion,
      os: record.os,
      osVersion: record.osVersion,
      deviceType: record.deviceType,
      screenWidth: record.screenWidth,
      screenHeight: record.screenHeight,
      language: record.language,
      status: "open",
      visibilityState: "visible",
      latitude: record.latitude,
      longitude: record.longitude,
    });
    await this.pushBufferedCustomEventsForVisit(record, logger);
  }

  private async advanceWaitingCustomEvents(
    siteId: string,
    visitId: string,
  ): Promise<void> {
    const visit = this.sqlOne<{ flushDueAt: number | null }>(
      `
        SELECT flush_due_at AS flushDueAt
        FROM buffered_visits
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
      siteId,
      visitId,
    );
    if (!visit || visit.flushDueAt === null) return;

    this.sqlRun(
      `
        UPDATE buffered_custom_events
        SET flush_due_at = CASE
              WHEN flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = CASE
              WHEN next_due_at IS NULL OR next_due_at > ? THEN ?
              ELSE next_due_at
            END,
            flush_attempts = 0,
            last_flush_error = NULL
        WHERE site_id = ?
          AND visit_id = ?
          AND dirty = 1
          AND last_flush_error = 'waiting_for_visit'
      `,
      visit.flushDueAt,
      visit.flushDueAt,
      visit.flushDueAt,
      visit.flushDueAt,
      siteId,
      visitId,
    );
  }

  private async pushBufferedCustomEventsForVisit(
    record: NormalizedPageview,
    logger?: InvocationLogger,
  ): Promise<void> {
    const pendingEvents = this.sqlAll<{
      eventId: string;
      eventAt: number;
      receivedAt: number;
      sequence: number;
      eventName: string;
      eventDataJson: string;
      userId: string;
    }>(
      `
        SELECT
          event_id AS eventId,
          occurred_at AS eventAt,
          received_at AS receivedAt,
          sequence,
          event_name AS eventName,
          event_data_json AS eventDataJson,
          user_id AS userId
        FROM buffered_custom_events
        WHERE site_id = ? AND visit_id = ?
        ORDER BY occurred_at ASC, created_at ASC
      `,
      record.siteId,
      record.visitId,
    );

    for (const pending of pendingEvents) {
      writeEventAnalyticsPoint(
        this.doEnv,
        {
          ...record,
          kind: "custom_event",
          eventId: pending.eventId,
          sequence: pending.sequence,
          receivedAt: pending.receivedAt,
          eventAt: pending.eventAt,
          eventName: pending.eventName,
          eventDataJson: pending.eventDataJson,
          userId: pending.userId || record.userId,
        },
        logger,
      );
      if (this.sockets.size === 0) continue;
      await this.pushRealtimeRecord({
        id: pending.eventId,
        eventType: pending.eventName,
        eventKind: "custom_event",
        eventAt: pending.eventAt,
        siteId: record.siteId,
        traceId: record.traceId,
        receivedAt: pending.receivedAt,
        sequence: pending.sequence,
        eventId: pending.eventId,
        eventName: pending.eventName,
        eventDataJson: pending.eventDataJson,
        visitId: record.visitId,
        sessionId: record.sessionId,
        startedAt: record.startedAt,
        pathname: record.pathname,
        queryString: record.queryString,
        hash: record.hashFragment,
        title: record.title,
        hostname: record.hostname,
        referrerUrl: record.referrerUrl,
        referrerHost: record.referrerHost,
        utmSource: record.utmSource,
        utmMedium: record.utmMedium,
        utmCampaign: record.utmCampaign,
        utmTerm: record.utmTerm,
        utmContent: record.utmContent,
        visitorId: record.visitorId,
        userId: pending.userId || record.userId,
        userName: record.userName,
        isEU: record.isEU,
        country: record.country,
        region: record.region,
        regionCode: record.regionCode,
        city: record.city,
        continent: record.continent,
        postalCode: record.postalCode,
        metroCode: record.metroCode,
        timezone: record.timezone,
        organization: record.asOrganization,
        uaRaw: record.uaRaw,
        browser: record.browser,
        browserVersion: record.browserVersion,
        os: record.os,
        osVersion: record.osVersion,
        deviceType: record.deviceType,
        screenWidth: record.screenWidth,
        screenHeight: record.screenHeight,
        language: record.language,
        status: "open",
        visibilityState: "visible",
        latitude: record.latitude,
        longitude: record.longitude,
      });
    }
  }

  private async handleLeave(
    record: NormalizedLeave,
    logger: InvocationLogger,
  ): Promise<void> {
    const visit = this.sqlOne<{
      visitId: string;
      startedAt: number;
      visitorId: string;
      siteId: string;
      sessionId: string;
      pathname: string;
      queryString: string;
      hash: string;
      title: string;
      hostname: string;
      referrerUrl: string;
      referrerHost: string;
      utmSource: string;
      utmMedium: string;
      utmCampaign: string;
      utmTerm: string;
      utmContent: string;
      userId: string;
      userName: string;
      isEU: number;
      country: string;
      region: string;
      regionCode: string;
      city: string;
      continent: string;
      postalCode: string;
      metroCode: string;
      timezone: string;
      organization: string;
      uaRaw: string;
      browser: string;
      browserVersion: string;
      os: string;
      osVersion: string;
      deviceType: string;
      language: string;
      screenWidth: number | null;
      screenHeight: number | null;
      endedAt: number | null;
      finalizedAt: number | null;
      durationMs: number | null;
      durationSource: string;
      exitReason: string;
      screenSize: string;
      latitude: number | null;
      longitude: number | null;
      perfTtfbMs: number | null;
      perfFcpMs: number | null;
      perfLcpMs: number | null;
      perfCls: number | null;
      perfInpMs: number | null;
      status: string;
      hiddenAt: number | null;
    }>(
      `
        SELECT visit_id AS visitId, started_at AS startedAt, visitor_id AS visitorId, site_id AS siteId,
               session_id AS sessionId, pathname, query_string AS queryString,
               hash_fragment AS hash, title, hostname,
               referrer_url AS referrerUrl, referrer_host AS referrerHost,
               utm_source AS utmSource, utm_medium AS utmMedium,
               utm_campaign AS utmCampaign, utm_term AS utmTerm,
               utm_content AS utmContent,
               user_id AS userId, user_name AS userName, is_eu AS isEU,
               country, region, region_code AS regionCode, city, continent, timezone,
               postal_code AS postalCode, metro_code AS metroCode,
               as_organization AS organization, ua_raw AS uaRaw,
               browser, browser_version AS browserVersion, os, os_version AS osVersion,
               device_type AS deviceType, language,
               screen_width AS screenWidth, screen_height AS screenHeight,
               CASE
                 WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL
                   THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
                 ELSE ''
               END AS screenSize,
               latitude, longitude, ended_at AS endedAt, finalized_at AS finalizedAt,
               duration_ms AS durationMs, duration_source AS durationSource,
               exit_reason AS exitReason,
               perf_ttfb_ms AS perfTtfbMs, perf_fcp_ms AS perfFcpMs,
               perf_lcp_ms AS perfLcpMs, perf_cls AS perfCls,
               perf_inp_ms AS perfInpMs,
               status, hidden_at AS hiddenAt
        FROM buffered_visits
        WHERE site_id = ? AND visit_id = ? AND status IN ('open', 'hidden_pending')
        LIMIT 1
      `,
      record.siteId,
      record.visitId,
    );

    let closedVisit = false;
    let closedLeaveAt = record.leaveAt;
    let closedDurationMs: number | null = null;
    let closedDurationSource = "";
    let closedExitReason = "";
    if (visit) {
      const reportedLeaveAt = Math.max(record.leaveAt, visit.startedAt);
      const hiddenAt =
        typeof visit.hiddenAt === "number"
          ? Math.max(visit.hiddenAt, visit.startedAt)
          : null;
      const useHiddenFallback =
        hiddenAt !== null && reportedLeaveAt - hiddenAt > HIDDEN_LEAVE_GRACE_MS;
      const leaveAt = useHiddenFallback ? hiddenAt : reportedLeaveAt;
      closedLeaveAt = leaveAt;
      const durationMs = Math.max(0, leaveAt - visit.startedAt);
      const durationSource = useHiddenFallback ? "hidden" : "server";
      const exitReason = useHiddenFallback
        ? "hidden_timeout"
        : record.exitReason || "pagehide";
      const flushDueAt = record.receivedAt + D1_FLUSH_INTERVAL_MS;
      closedDurationMs = durationMs;
      closedDurationSource = durationSource;
      closedExitReason = exitReason;

      const rowsWritten = this.sqlRun(
        `
          UPDATE buffered_visits
          SET status = 'complete',
              last_activity_at = ?,
              hidden_at = NULL,
              ended_at = ?,
              finalized_at = ?,
              duration_ms = ?,
              duration_source = ?,
              exit_reason = ?,
              dirty = 1,
              buffer_revision = buffer_revision + 1,
              flush_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              next_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              updated_at = ?
          WHERE visit_id = ? AND status IN ('open', 'hidden_pending')
        `,
        leaveAt,
        leaveAt,
        leaveAt,
        durationMs,
        durationSource,
        exitReason,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        toUnixSeconds(record.receivedAt),
        visit.visitId,
      );
      closedVisit = rowsWritten > 0;
      logger.info(
        closedVisit ? "do.ingest.leave_closed" : "do.ingest.leave_race_lost",
      );
    }

    if (record.performance) {
      await this.attachPerformanceToVisit(
        record.siteId,
        record.performanceVisitId,
        record.performance,
        record.receivedAt,
      );
    }

    if (!visit || !closedVisit) {
      logger.info("do.ingest.leave_ignored");
      return;
    }

    writeTrafficVisitFinalizedFact(
      this.doEnv,
      {
        visit: {
          siteId: visit.siteId,
          visitId: visit.visitId,
          visitorId: visit.visitorId,
          sessionId: visit.sessionId,
          startedAt: visit.startedAt,
          pathname: visit.pathname,
          queryString: visit.queryString,
          hashFragment: visit.hash,
          title: visit.title,
          hostname: visit.hostname,
          referrerUrl: visit.referrerUrl,
          referrerHost: visit.referrerHost,
          utmSource: visit.utmSource,
          utmMedium: visit.utmMedium,
          utmCampaign: visit.utmCampaign,
          utmTerm: visit.utmTerm,
          utmContent: visit.utmContent,
          region: visit.region,
          city: visit.city,
          continent: visit.continent,
          country: visit.country,
          regionCode: visit.regionCode,
          postalCode: visit.postalCode,
          metroCode: visit.metroCode,
          timezone: visit.timezone,
          asOrganization: visit.organization,
          browser: visit.browser,
          browserVersion: visit.browserVersion,
          os: visit.os,
          osVersion: visit.osVersion,
          deviceType: visit.deviceType,
          language: visit.language,
          latitude: visit.latitude,
          longitude: visit.longitude,
          screenWidth: visit.screenWidth,
          screenHeight: visit.screenHeight,
          perfTtfbMs: record.performance?.ttfb ?? visit.perfTtfbMs,
          perfFcpMs: record.performance?.fcp ?? visit.perfFcpMs,
          perfLcpMs: record.performance?.lcp ?? visit.perfLcpMs,
          perfCls: record.performance?.cls ?? visit.perfCls,
          perfInpMs: record.performance?.inp ?? visit.perfInpMs,
        },
        receivedAt: record.receivedAt,
        endedAt: closedLeaveAt,
        durationMs: closedDurationMs,
        durationSource: closedDurationSource,
        exitReason: closedExitReason,
      },
      logger,
    );

    if (!this.hasOpenVisitsForVisitor(visit.siteId, visit.visitorId)) {
      await this.pushRealtimeRecord({
        id: `leave:${visit.visitId}`,
        eventType: WS_PRESENCE_LEAVE_EVENT,
        eventKind: "leave",
        eventAt: closedLeaveAt,
        siteId: visit.siteId,
        receivedAt: record.receivedAt,
        visitId: visit.visitId,
        sessionId: visit.sessionId,
        startedAt: visit.startedAt,
        pathname: visit.pathname,
        queryString: visit.queryString,
        hash: visit.hash,
        title: visit.title,
        hostname: visit.hostname,
        referrerUrl: visit.referrerUrl,
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
        utmTerm: visit.utmTerm,
        utmContent: visit.utmContent,
        visitorId: visit.visitorId,
        userId: visit.userId,
        userName: visit.userName,
        isEU: visit.isEU,
        country: visit.country,
        region: visit.region,
        regionCode: visit.regionCode,
        city: visit.city,
        continent: visit.continent,
        postalCode: visit.postalCode,
        metroCode: visit.metroCode,
        timezone: visit.timezone,
        organization: visit.organization,
        uaRaw: visit.uaRaw,
        browser: visit.browser,
        browserVersion: visit.browserVersion,
        os: visit.os,
        osVersion: visit.osVersion,
        deviceType: visit.deviceType,
        language: visit.language,
        screenWidth: visit.screenWidth,
        screenHeight: visit.screenHeight,
        status: "complete",
        hiddenAt: null,
        endedAt: closedLeaveAt,
        finalizedAt: closedLeaveAt,
        durationMs: closedDurationMs,
        durationSource: closedDurationSource,
        exitReason: closedExitReason,
        leaveAt: closedLeaveAt,
        performanceVisitId: record.performanceVisitId,
        performance: record.performance,
        latitude: visit.latitude,
        longitude: visit.longitude,
      });
    }
  }

  private async handleVisibility(
    record: NormalizedVisibility,
    logger: InvocationLogger,
  ): Promise<void> {
    const updatedAt = toUnixSeconds(record.receivedAt);
    const flushDueAt = record.receivedAt + D1_FLUSH_INTERVAL_MS;
    if (record.visibilityState === "hidden") {
      let rowsWritten = this.sqlRun(
        `
          UPDATE buffered_visits
          SET status = 'hidden_pending',
              hidden_at = ?,
              last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END,
              dirty = 1,
              buffer_revision = buffer_revision + 1,
              flush_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              next_due_at = MIN(
                CASE
                  WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                  ELSE flush_due_at
                END,
                ?
              ),
              updated_at = ?
          WHERE site_id = ?
            AND visit_id = ?
            AND status = 'open'
        `,
        record.eventAt,
        record.eventAt,
        record.eventAt,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        record.eventAt + HIDDEN_LEAVE_GRACE_MS,
        updatedAt,
        record.siteId,
        record.visitId,
      );
      if (rowsWritten === 0) {
        rowsWritten = this.sqlRun(
          `
            UPDATE buffered_visits
            SET hidden_at = COALESCE(hidden_at, ?),
                last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END,
                dirty = 1,
                buffer_revision = buffer_revision + 1,
                flush_due_at = CASE
                  WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                  ELSE flush_due_at
                END,
                next_due_at = MIN(
                  CASE
                    WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                    ELSE flush_due_at
                  END,
                  COALESCE(hidden_at, ?) + ?
                ),
                updated_at = ?
            WHERE site_id = ?
              AND visit_id = ?
              AND status = 'hidden_pending'
              AND (
                last_activity_at < ?
                OR (hidden_at IS NULL AND last_activity_at = ?)
              )
          `,
          record.eventAt,
          record.eventAt,
          record.eventAt,
          flushDueAt,
          flushDueAt,
          flushDueAt,
          flushDueAt,
          record.eventAt,
          HIDDEN_LEAVE_GRACE_MS,
          updatedAt,
          record.siteId,
          record.visitId,
          record.eventAt,
          record.eventAt,
        );
      }
      logger.info(
        rowsWritten > 0
          ? "do.ingest.visibility_hidden_buffered"
          : "do.ingest.visibility_hidden_ignored",
      );
      if (rowsWritten > 0) {
        await this.pushVisibilityRealtimeRecord(record);
      }
      return;
    }

    const rowsWritten = this.sqlRun(
      `
        UPDATE buffered_visits
        SET status = 'open',
            hidden_at = NULL,
            last_activity_at = CASE WHEN last_activity_at > ? THEN last_activity_at ELSE ? END,
            dirty = 1,
            buffer_revision = buffer_revision + 1,
            flush_due_at = CASE
              WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = MIN(
              CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              ?
            ),
            updated_at = ?
        WHERE site_id = ?
          AND visit_id = ?
          AND status = 'hidden_pending'
          AND (hidden_at IS NULL OR ? - hidden_at <= ?)
      `,
      record.eventAt,
      record.eventAt,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      record.eventAt + VISIT_TIMEOUT_MS,
      updatedAt,
      record.siteId,
      record.visitId,
      record.eventAt,
      HIDDEN_LEAVE_GRACE_MS,
    );
    logger.info(
      rowsWritten > 0
        ? "do.ingest.visibility_visible_restored"
        : "do.ingest.visibility_visible_ignored",
    );
    if (rowsWritten > 0) {
      await this.pushVisibilityRealtimeRecord(record);
    }
  }

  private async pushVisibilityRealtimeRecord(
    record: NormalizedVisibility,
  ): Promise<void> {
    const visit = await this.getVisitContext(record.siteId, record.visitId);
    if (!visit) return;

    await this.pushRealtimeRecord({
      id: `visibility:${record.visitId}:${record.eventAt}:${record.visibilityState}`,
      eventType: "visibility",
      eventKind: "visibility",
      eventAt: record.eventAt,
      siteId: record.siteId,
      traceId: record.traceId,
      receivedAt: record.receivedAt,
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      startedAt: visit.startedAt,
      pathname: visit.pathname,
      queryString: visit.queryString,
      hash: visit.hashFragment,
      title: visit.title,
      hostname: visit.hostname,
      referrerUrl: visit.referrerUrl,
      referrerHost: visit.referrerHost,
      utmSource: visit.utmSource,
      utmMedium: visit.utmMedium,
      utmCampaign: visit.utmCampaign,
      utmTerm: visit.utmTerm,
      utmContent: visit.utmContent,
      visitorId: visit.visitorId,
      userId: visit.userId,
      userName: visit.userName,
      isEU: visit.isEU,
      country: visit.country,
      region: visit.region,
      regionCode: visit.regionCode,
      city: visit.city,
      continent: visit.continent,
      postalCode: visit.postalCode,
      metroCode: visit.metroCode,
      timezone: visit.timezone,
      organization: visit.asOrganization,
      uaRaw: visit.uaRaw,
      browser: visit.browser,
      browserVersion: visit.browserVersion,
      os: visit.os,
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      screenWidth: visit.screenWidth,
      screenHeight: visit.screenHeight,
      language: visit.language,
      status: record.visibilityState === "hidden" ? "hidden_pending" : "open",
      hiddenAt: record.visibilityState === "hidden" ? record.eventAt : null,
      visibilityState: record.visibilityState,
      latitude: visit.latitude,
      longitude: visit.longitude,
    });
  }

  private async attachPerformanceToVisit(
    siteId: string,
    visitId: string,
    performance: TrackerPerformancePayload,
    receivedAt: number,
  ): Promise<void> {
    return attachPerformanceToVisitInBufferStore(
      this.bufferStoreContext(),
      siteId,
      visitId,
      performance,
      receivedAt,
    );
  }

  private async handleCustomEvent(
    record: NormalizedCustomEvent,
    logger: InvocationLogger,
  ): Promise<void> {
    const inserted = await this.insertCustomEvent(record);
    if (!inserted) {
      logger.info("do.ingest.custom_event_duplicate");
      return;
    }
    logger.info("do.ingest.custom_event_buffered");
    writeEventAnalyticsPoint(this.doEnv, record, logger);
    await this.updateOpenVisitActivity(record.visitId, record.eventAt);
    await this.pushRealtimeRecord({
      id: record.eventId,
      eventType: record.eventName,
      eventKind: "custom_event",
      eventAt: record.eventAt,
      siteId: record.siteId,
      traceId: record.traceId,
      receivedAt: record.receivedAt,
      sequence: record.sequence,
      eventId: record.eventId,
      eventName: record.eventName,
      eventDataJson: record.eventDataJson,
      visitId: record.visitId,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      pathname: record.pathname,
      queryString: record.queryString,
      hash: record.hashFragment,
      title: record.title,
      hostname: record.hostname,
      referrerUrl: record.referrerUrl,
      referrerHost: record.referrerHost,
      utmSource: record.utmSource,
      utmMedium: record.utmMedium,
      utmCampaign: record.utmCampaign,
      utmTerm: record.utmTerm,
      utmContent: record.utmContent,
      visitorId: record.visitorId,
      userId: record.userId,
      userName: record.userName,
      isEU: record.isEU,
      country: record.country,
      region: record.region,
      regionCode: record.regionCode,
      city: record.city,
      continent: record.continent,
      postalCode: record.postalCode,
      metroCode: record.metroCode,
      timezone: record.timezone,
      organization: record.asOrganization,
      uaRaw: record.uaRaw,
      browser: record.browser,
      browserVersion: record.browserVersion,
      os: record.os,
      osVersion: record.osVersion,
      deviceType: record.deviceType,
      screenWidth: record.screenWidth,
      screenHeight: record.screenHeight,
      language: record.language,
      status: "open",
      visibilityState: "visible",
      latitude: record.latitude,
      longitude: record.longitude,
    });
  }

  private async handleIdentify(
    record: NormalizedIdentify,
    logger: InvocationLogger,
  ): Promise<void> {
    const now = Date.now();
    const updatedAt = toUnixSeconds(now);
    const flushDueAt = now + D1_FLUSH_INTERVAL_MS;
    const localVisit = this.sqlOne<{ sessionId: string | null }>(
      `
        SELECT session_id AS sessionId
        FROM buffered_visits
        WHERE visit_id = ? AND site_id = ?
        LIMIT 1
      `,
      record.visitId,
      record.siteId,
    );
    let serverSessionId = localVisit?.sessionId || "";

    const rowsUpdated = this.sqlRun(
      `
        UPDATE buffered_visits
        SET user_id = ?, user_name = ?, dirty = 1,
            buffer_revision = buffer_revision + 1,
            flush_due_at = CASE
              WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = CASE
              WHEN status = 'open' THEN MIN(
                CASE
                  WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                  ELSE flush_due_at
                END,
                last_activity_at + ?
              )
              WHEN status = 'hidden_pending' THEN MIN(
                CASE
                  WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                  ELSE flush_due_at
                END,
                COALESCE(hidden_at, last_activity_at) + ?
              )
              ELSE CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END
            END,
            updated_at = ?
        WHERE visit_id = ?
          AND site_id = ?
          AND (user_id IS NOT ? OR user_name IS NOT ?)
      `,
      record.userId,
      record.userName || null,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      VISIT_TIMEOUT_MS,
      flushDueAt,
      flushDueAt,
      HIDDEN_LEAVE_GRACE_MS,
      flushDueAt,
      flushDueAt,
      updatedAt,
      record.visitId,
      record.siteId,
      record.userId,
      record.userName || null,
    );

    // Update buffered_custom_events for the same visit
    this.sqlRun(
      `
        UPDATE buffered_custom_events
        SET user_id = ?, dirty = 1,
            flush_due_at = CASE
              WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = CASE
              WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            buffer_revision = buffer_revision + 1
        WHERE visit_id = ?
          AND site_id = ?
          AND user_id IS NOT ?
      `,
      record.userId,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      flushDueAt,
      record.visitId,
      record.siteId,
      record.userId,
    );

    if (rowsUpdated === 0) {
      if (!serverSessionId && !localVisit) {
        const persistedVisit = await this.doEnv.DB.prepare(
          `
            SELECT session_id AS sessionId
            FROM visits
            WHERE visit_id = ? AND site_pk = ${SITE_PK_FROM_SITE_ID_SQL}
            LIMIT 1
          `,
        )
          .bind(record.visitId, record.siteId)
          .first<{ sessionId: string }>()
          .catch(() => null);
        serverSessionId = persistedVisit?.sessionId || "";
      }
      await this.doEnv.DB.prepare(
        `
          UPDATE visits
          SET user_id = ?, user_name = ?
          WHERE visit_id = ? AND site_pk = ${SITE_PK_FROM_SITE_ID_SQL}
        `,
      )
        .bind(
          record.userId,
          record.userName || null,
          record.visitId,
          record.siteId,
        )
        .run()
        .catch(() => {});
    }

    if (serverSessionId) {
      this.sqlRun(
        `
          UPDATE buffered_visits
          SET user_id = ?, user_name = ?, dirty = 1,
              buffer_revision = buffer_revision + 1,
              flush_due_at = CASE
                WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                ELSE flush_due_at
              END,
              next_due_at = CASE
                WHEN status = 'open' THEN MIN(
                  CASE
                    WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                    ELSE flush_due_at
                  END,
                  last_activity_at + ?
                )
                WHEN status = 'hidden_pending' THEN MIN(
                  CASE
                    WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                    ELSE flush_due_at
                  END,
                  COALESCE(hidden_at, last_activity_at) + ?
                )
                ELSE CASE
                  WHEN dirty = 0 OR flush_due_at IS NULL OR flush_due_at > ? THEN ?
                  ELSE flush_due_at
                END
              END,
              updated_at = ?
          WHERE session_id = ?
            AND site_id = ?
            AND visit_id != ?
            AND (user_id = '' OR user_id IS NULL)
            AND (user_id IS NOT ? OR user_name IS NOT ?)
        `,
        record.userId,
        record.userName || null,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        flushDueAt,
        VISIT_TIMEOUT_MS,
        flushDueAt,
        flushDueAt,
        HIDDEN_LEAVE_GRACE_MS,
        flushDueAt,
        flushDueAt,
        updatedAt,
        serverSessionId,
        record.siteId,
        record.visitId,
        record.userId,
        record.userName || null,
      );
    }
    logger.info(
      rowsUpdated > 0
        ? "do.ingest.identify_buffered"
        : "do.ingest.identify_persisted",
    );
    await this.pushRealtimeRecord({
      id: `identify:${record.visitId}:${record.receivedAt}`,
      eventType: "identify",
      eventKind: "identify",
      eventAt: record.receivedAt,
      siteId: record.siteId,
      traceId: record.traceId,
      receivedAt: record.receivedAt,
      visitId: record.visitId,
      sessionId: serverSessionId,
      pathname: "",
      hash: "",
      title: "",
      hostname: "",
      referrerUrl: "",
      referrerHost: "",
      visitorId: "",
      userId: record.userId,
      userName: record.userName,
      country: "",
      region: "",
      regionCode: "",
      city: "",
      continent: "",
      timezone: "",
      organization: "",
      browser: "",
      os: "",
      osVersion: "",
      deviceType: "",
      language: "",
      latitude: null,
      longitude: null,
    });
  }

  private async getVisitContext(
    siteId: string,
    visitId: string,
  ): Promise<StoredOpenVisit | null> {
    return getVisitContextFromBufferStore(
      this.bufferStoreContext(),
      siteId,
      visitId,
    );
  }

  private readTrafficVisitSnapshot(
    siteId: string,
    visitId: string,
  ): TrafficVisitSnapshot | null {
    return this.sqlOne<TrafficVisitSnapshot>(
      `
        SELECT
          site_id AS siteId,
          visit_id AS visitId,
          visitor_id AS visitorId,
          session_id AS sessionId,
          started_at AS startedAt,
          pathname,
          query_string AS queryString,
          hash_fragment AS hashFragment,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          utm_source AS utmSource,
          utm_medium AS utmMedium,
          utm_campaign AS utmCampaign,
          utm_term AS utmTerm,
          utm_content AS utmContent,
          region,
          city,
          continent,
          country,
          region_code AS regionCode,
          postal_code AS postalCode,
          metro_code AS metroCode,
          timezone,
          as_organization AS asOrganization,
          browser,
          browser_version AS browserVersion,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          language,
          latitude,
          longitude,
          screen_width AS screenWidth,
          screen_height AS screenHeight,
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

  private async findRecentVisitorSession(input: {
    siteId: string;
    visitorId: string;
    visitId: string;
    startedAt: number;
    sessionWindowMs: number;
    routePreviousHostname?: string;
    routePreviousPathname?: string;
    routePreviousQueryString?: string;
    routePreviousHashFragment?: string;
  }): Promise<RecentVisitorSession | null> {
    return findRecentVisitorSessionInBufferStore(
      this.bufferStoreContext(),
      input,
    );
  }

  private async readPersistedVisitRow(
    siteId: string,
    visitId: string,
  ): Promise<BufferedVisitRow | null> {
    return readPersistedVisitRowFromBufferStore(
      this.bufferStoreContext(),
      siteId,
      visitId,
    );
  }

  private insertBufferedVisitRow(row: BufferedVisitRow): void {
    insertBufferedVisitRowInBufferStore(this.bufferStoreContext(), row);
  }

  private async insertVisit(record: NormalizedPageview): Promise<boolean> {
    return insertVisitInBufferStore(this.bufferStoreContext(), record);
  }

  private async insertCustomEvent(
    record: NormalizedCustomEvent,
  ): Promise<boolean> {
    return insertCustomEventInBufferStore(this.bufferStoreContext(), record);
  }

  private insertBufferedCustomEvent(record: BufferedCustomEventInput): boolean {
    return insertBufferedCustomEventInBufferStore(
      this.bufferStoreContext(),
      record,
    );
  }

  private async updateOpenVisitActivity(
    visitId: string,
    eventAt: number,
  ): Promise<void> {
    return updateOpenVisitActivityInBufferStore(
      this.bufferStoreContext(),
      visitId,
      eventAt,
    );
  }

  private async pushRealtimeRecord(
    record: RealtimeSnapshotRecord,
  ): Promise<void> {
    await pushRealtimeRecordToSockets(this.sockets, record);
  }

  private async reconcileAlarm(
    logger: InvocationLogger,
    afterMaintenance = false,
    alarmInfo?: { retryCount?: number; isRetry?: boolean },
    retryOnFailure = false,
  ): Promise<void> {
    const now = Date.now();
    const nextDue = getEarliestDueWork({
      sqlOne: <T>(query: string, ...bindings: SqlBinding[]) =>
        this.sqlOne<T>(query, ...bindings),
    });
    const current = await this.doState.storage.getAlarm();

    if (nextDue.nextDueAt === null) {
      if (current !== null) {
        await this.doState.storage.deleteAlarm();
        logger.info("do.alarm.reconciled", {
          action: "deleted",
          previousAlarmAt: current,
          targetAlarmAt: null,
          nextDueAt: null,
          nextDueKind: null,
          nextDueEntity: null,
          afterMaintenance,
          isOverdueRetry: false,
          retryCount: alarmInfo?.retryCount ?? 0,
          isRetry: Boolean(alarmInfo?.isRetry),
        });
      }
      return;
    }

    const isOverdue = nextDue.nextDueAt <= now;
    const retryAt = now + D1_FLUSH_INTERVAL_MS;
    // A previously scheduled Alarm can remain in storage after its delivery
    // was stranded. Reconcile requests are the recovery path for those DOs,
    // so move a sufficiently old due Alarm back to "now". Keep a short grace
    // period after repairing it to avoid turning every ingest request into
    // another Alarm write while the platform is dispatching the Alarm.
    const isOverdueAlarmRepair =
      current !== null && current <= now - D1_FLUSH_INTERVAL_MS;
    const target = retryOnFailure
      ? isOverdue
        ? retryAt
        : Math.min(nextDue.nextDueAt, retryAt)
      : isOverdue && afterMaintenance
        ? retryAt
        : isOverdue
          ? now
          : nextDue.nextDueAt;
    const isOverdueRetry = isOverdue && afterMaintenance;

    if (current === null) {
      await this.doState.storage.setAlarm(target);
      logger.info("do.alarm.reconciled", {
        action: "set",
        previousAlarmAt: null,
        targetAlarmAt: target,
        nextDueAt: nextDue.nextDueAt,
        nextDueKind: nextDue.reason,
        nextDueEntity: nextDue.entity,
        afterMaintenance,
        isOverdueRetry,
        retryOnFailure,
        retryCount: alarmInfo?.retryCount ?? 0,
        isRetry: Boolean(alarmInfo?.isRetry),
      });
      return;
    }

    if (
      current > target ||
      (retryOnFailure && current <= now) ||
      isOverdueAlarmRepair
    ) {
      await this.doState.storage.setAlarm(target);
      logger.info("do.alarm.reconciled", {
        action: "set",
        previousAlarmAt: current,
        targetAlarmAt: target,
        nextDueAt: nextDue.nextDueAt,
        nextDueKind: nextDue.reason,
        nextDueEntity: nextDue.entity,
        afterMaintenance,
        isOverdueRetry,
        retryOnFailure,
        isOverdueAlarmRepair,
        retryCount: alarmInfo?.retryCount ?? 0,
        isRetry: Boolean(alarmInfo?.isRetry),
      });
      return;
    }

    logger.info("do.alarm.reconciled", {
      action: "kept",
      previousAlarmAt: current,
      targetAlarmAt: target,
      nextDueAt: nextDue.nextDueAt,
      nextDueKind: nextDue.reason,
      nextDueEntity: nextDue.entity,
      afterMaintenance,
      isOverdueRetry,
      retryOnFailure,
      isOverdueAlarmRepair,
      retryCount: alarmInfo?.retryCount ?? 0,
      isRetry: Boolean(alarmInfo?.isRetry),
    });
  }

  private hasOpenVisitsForVisitor(siteId: string, visitorId: string): boolean {
    const row = this.sqlOne<{ ok: number }>(
      `
        SELECT 1 AS ok
        FROM buffered_visits
        WHERE site_id = ?
          AND visitor_id = ?
          AND status = 'open'
        LIMIT 1
      `,
      siteId,
      visitorId,
    );
    return row !== null;
  }

  private async pushInitialSnapshotToSocket(
    socket: WebSocket,
    logger: InvocationLogger,
  ): Promise<boolean> {
    return pushInitialRealtimeSnapshot(
      {
        sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
          this.measuredSqlAll<T>(logger, query, ...bindings),
        sqlOne: <T>(query: string, ...bindings: SqlBinding[]) =>
          this.measuredSqlOne<T>(logger, query, ...bindings),
        sockets: this.sockets,
      },
      socket,
    );
  }

  private flushStoreContext(logger: InvocationLogger) {
    const env = instrumentEnv(this.doEnv, logger);
    return {
      env,
      dictionaryIds: this.dictionaryIds,
      sitePks: this.sitePks,
      sqlAll: <T>(query: string, ...bindings: SqlBinding[]) =>
        this.measuredSqlAll<T>(logger, query, ...bindings),
      sqlOne: <T>(query: string, ...bindings: SqlBinding[]) =>
        this.measuredSqlOne<T>(logger, query, ...bindings),
      sqlRun: (query: string, ...bindings: SqlBinding[]) =>
        this.measuredSqlRun(logger, query, ...bindings),
      readPersistedVisitRow: this.readPersistedVisitRow.bind(this),
      insertBufferedVisitRow: this.insertBufferedVisitRow.bind(this),
      hasOpenVisitsForVisitor: this.hasOpenVisitsForVisitor.bind(this),
      pushRealtimeRecord: this.pushRealtimeRecord.bind(this),
      writeTrafficVisitFinalizedFact: (
        input: Parameters<typeof writeTrafficVisitFinalizedFact>[1],
      ) => writeTrafficVisitFinalizedFact(this.doEnv, input, logger),
      writeTrafficSessionEndedFact: (
        input: Parameters<typeof writeTrafficSessionEndedFact>[1],
      ) => writeTrafficSessionEndedFact(this.doEnv, input, logger),
      observability: logger,
    };
  }

  private async flushPendingToD1(
    logger: InvocationLogger,
    force = false,
  ): Promise<void> {
    return flushPendingToD1InFlushStore(this.flushStoreContext(logger), force);
  }

  private async cleanupBufferedRows(logger: InvocationLogger): Promise<void> {
    return cleanupBufferedRowsInFlushStore(this.flushStoreContext(logger));
  }

  private async flushTimeouts(logger: InvocationLogger): Promise<void> {
    return flushTimeoutsInFlushStore(this.flushStoreContext(logger));
  }

  private async runMaintenance(
    logger: InvocationLogger,
    forceFlush = false,
  ): Promise<void> {
    await logger.measure("do.flush_timeouts", () => this.flushTimeouts(logger));
    await logger.measure("do.flush_pending", () =>
      this.flushPendingToD1(logger, forceFlush),
    );
    await logger.measure("do.cleanup", () => this.cleanupBufferedRows(logger));
  }
}
