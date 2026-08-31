import {
  D1_FLUSH_BATCH_SIZE,
  D1_FLUSH_CUSTOM_EVENT_BATCH_SIZE,
  D1_FLUSH_MAX_BATCHES_PER_ALARM,
  FLUSHED_BUFFER_RETENTION_MS,
  HIDDEN_LEAVE_GRACE_MS,
  ORPHAN_CUSTOM_EVENT_TIMEOUT_MS,
  TIMEOUT_FINALIZE_BATCH_SIZE,
  VISIT_TIMEOUT_MS,
  WS_PRESENCE_LEAVE_EVENT,
} from "./ingest-constants";
import { flushCustomEventRowIndividually } from "./ingest-custom-event-flush";
import {
  type IngestFlushContext,
  recordFlushCounter,
  resolveSitePk,
} from "./ingest-flush-types";
import { visitBindings, visitUpsertSql } from "./ingest-sql";
import { toUnixSeconds } from "./ingest-time";
import type { BufferedCustomEventRow, BufferedVisitRow } from "./ingest-types";
import { clampString } from "./utils";

interface FlushBufferFields {
  bufferRevision: number;
  flushDueAt: number | null;
  nextDueAt: number | null;
}

type BufferedVisitFlushRow = BufferedVisitRow & Partial<FlushBufferFields>;
type BufferedCustomEventFlushRow = BufferedCustomEventRow &
  Partial<FlushBufferFields>;

const FLUSH_RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  4 * 60 * 1000,
  8 * 60 * 1000,
  15 * 60 * 1000,
] as const;

interface TimedOutVisitCandidate {
  visitId: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  status: string;
  startedAt: number;
  lastActivityAt: number;
  hiddenAt: number | null;
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
  screenSize: string;
  latitude: number | null;
  longitude: number | null;
}

async function pushFinalizedVisitRealtimeEvent(
  context: IngestFlushContext,
  visit: TimedOutVisitCandidate,
  eventAt: number,
  durationMs: number | null,
  durationSource: string,
  exitReason: string,
): Promise<void> {
  await context.pushRealtimeRecord({
    id: `leave:${visit.visitId}`,
    eventType: WS_PRESENCE_LEAVE_EVENT,
    eventKind: "leave",
    eventAt,
    siteId: visit.siteId,
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
    screenWidth: visit.screenWidth,
    screenHeight: visit.screenHeight,
    language: visit.language,
    status: "complete",
    endedAt: eventAt,
    finalizedAt: eventAt,
    durationMs,
    durationSource,
    exitReason,
    leaveAt: eventAt,
    latitude: visit.latitude,
    longitude: visit.longitude,
  });
}

export async function flushPendingToD1(
  context: IngestFlushContext,
  force = false,
): Promise<void> {
  let batches = 0;
  while (batches < D1_FLUSH_MAX_BATCHES_PER_ALARM) {
    batches += 1;
    const now = Date.now();
    const dueFilter = force ? "" : "AND flush_due_at <= ?";
    const visitRows = context.sqlAll<BufferedVisitFlushRow>(
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
          user_id,
          user_name,
          perf_ttfb_ms AS perfTtfbMs,
          perf_fcp_ms AS perfFcpMs,
          perf_lcp_ms AS perfLcpMs,
          perf_cls AS perfCls,
          perf_inp_ms AS perfInpMs,
          dirty,
          flush_attempts AS flushAttempts,
          buffer_revision AS bufferRevision,
          flush_due_at AS flushDueAt,
          next_due_at AS nextDueAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM buffered_visits
        WHERE dirty = 1
          AND flush_due_at IS NOT NULL
          ${dueFilter}
        ORDER BY flush_due_at ASC, updated_at ASC, flush_attempts ASC
        LIMIT ?
      `,
      ...(force ? [] : [now]),
      D1_FLUSH_BATCH_SIZE,
    );
    const eventRows = context.sqlAll<BufferedCustomEventFlushRow>(
      `
        SELECT
          event_id AS eventId,
          site_id AS siteId,
          visit_id AS visitId,
          occurred_at AS occurredAt,
          received_at AS receivedAt,
          sequence,
          event_name AS eventName,
          event_data_json AS eventDataJson,
          user_id AS userId,
          dirty,
          flush_attempts AS flushAttempts,
          last_flush_error AS lastFlushError,
          buffer_revision AS bufferRevision,
          flush_due_at AS flushDueAt,
          next_due_at AS nextDueAt,
          created_at AS createdAt
        FROM buffered_custom_events
        WHERE dirty = 1
          AND flush_due_at IS NOT NULL
          ${dueFilter}
        ORDER BY flush_due_at ASC, created_at ASC, flush_attempts ASC
        LIMIT ?
      `,
      ...(force ? [] : [now]),
      D1_FLUSH_CUSTOM_EVENT_BATCH_SIZE,
    );

    if (visitRows.length === 0 && eventRows.length === 0) {
      return;
    }
    context.observability?.info("do.flush.pending_batch");

    if (visitRows.length > 0) {
      try {
        const sitePkById = new Map<string, number>();
        for (const siteId of new Set(visitRows.map((row) => row.siteId))) {
          sitePkById.set(siteId, await resolveSitePk(context, siteId));
        }
        recordFlushCounter(context, "d1Statements", visitRows.length);
        const preparedVisits = visitRows.map((row) => {
          const sitePk = sitePkById.get(row.siteId);
          if (sitePk === undefined) {
            throw new Error(`Missing site identity for ${row.siteId}`);
          }
          return prepareVisitStatement(context, row, sitePk);
        });
        await context.env.DB.batch(preparedVisits);
        recordFlushCounter(context, "flushedVisits", visitRows.length);
        markVisitRowsFlushed(context, visitRows);
      } catch (error) {
        void error;
        recordFlushCounter(context, "failedStatements", visitRows.length);
        context.observability?.error("do.flush.visit_batch_failed");
        await flushRowsIndividually(context, visitRows, []);
      }
    }

    let flushedAnyEvent = false;
    for (const eventRow of eventRows) {
      flushedAnyEvent =
        (await flushCustomEventRowIndividually(context, eventRow)) ||
        flushedAnyEvent;
    }

    if (visitRows.length === 0 && eventRows.length > 0 && !flushedAnyEvent) {
      return;
    }

    if (
      visitRows.length < D1_FLUSH_BATCH_SIZE &&
      eventRows.length < D1_FLUSH_CUSTOM_EVENT_BATCH_SIZE
    ) {
      return;
    }
  }
}

export async function cleanupBufferedRows(
  context: IngestFlushContext,
): Promise<void> {
  const now = Date.now();
  const visitCutoff = now - FLUSHED_BUFFER_RETENTION_MS;
  const hiddenFallbackCutoff = now - VISIT_TIMEOUT_MS;
  const eventCutoff = visitCutoff;
  const deletedVisits = context.sqlRun(
    `
      DELETE FROM buffered_visits
      WHERE dirty = 0
        AND (
          status = 'timeout'
          OR (
            status NOT IN ('open', 'hidden_pending')
            AND (COALESCE(duration_source, '') = 'hidden' OR COALESCE(exit_reason, '') = 'hidden_timeout')
            AND COALESCE(finalized_at, ended_at, started_at) < ?
          )
          OR (
            status NOT IN ('open', 'hidden_pending')
            AND NOT (COALESCE(duration_source, '') = 'hidden' OR COALESCE(exit_reason, '') = 'hidden_timeout')
            AND COALESCE(finalized_at, ended_at, started_at) < ?
          )
        )
    `,
    hiddenFallbackCutoff,
    visitCutoff,
  );
  if (deletedVisits > 0) {
    context.observability?.info("do.cleanup.visit_rows_deleted");
  }
  const deletedEvents = context.sqlRun(
    `
      DELETE FROM buffered_custom_events
      WHERE dirty = 0
        AND occurred_at < ?
    `,
    eventCutoff,
  );
  if (deletedEvents > 0) {
    context.observability?.info("do.cleanup.custom_event_rows_deleted");
  }
  await cleanupOrphanedCustomEvents(context, now);
}

export async function flushTimeouts(
  context: IngestFlushContext,
): Promise<void> {
  const now = Date.now();
  await flushHiddenFallbacks(context, now);
  const rows = context.sqlAll<TimedOutVisitCandidate>(
    `
      SELECT
        visit_id AS visitId,
        site_id AS siteId,
        visitor_id AS visitorId,
        session_id AS sessionId,
        status,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        hidden_at AS hiddenAt,
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
        language,
        screen_width AS screenWidth,
        screen_height AS screenHeight,
        CASE
          WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL
            THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
          ELSE ''
        END AS screenSize,
        latitude,
        longitude
      FROM buffered_visits
      WHERE (
          status = 'open'
          OR (status = 'hidden_pending' AND hidden_at IS NULL)
        )
        AND last_activity_at <= ?
      LIMIT ?
    `,
    now - VISIT_TIMEOUT_MS,
    TIMEOUT_FINALIZE_BATCH_SIZE,
  );
  if (rows.length > 0) {
    context.observability?.info("do.timeout_visits_found");
  }

  for (const visit of rows) {
    const rowsWritten = context.sqlRun(
      `
        UPDATE buffered_visits
        SET status = 'timeout',
            last_activity_at = ?,
            hidden_at = NULL,
            ended_at = ?,
            finalized_at = ?,
            duration_ms = NULL,
            duration_source = 'timeout',
            dirty = 1,
            updated_at = ?,
            flush_due_at = CASE
              WHEN flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = CASE
              WHEN flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            buffer_revision = buffer_revision + 1
        WHERE site_id = ?
          AND visit_id = ?
          AND (status = 'open' OR (status = 'hidden_pending' AND hidden_at IS NULL))
      `,
      now,
      now,
      now,
      toUnixSeconds(now),
      now,
      now,
      now,
      now,
      visit.siteId,
      visit.visitId,
    );
    if (rowsWritten === 0) continue;
    if (!context.hasOpenVisitsForVisitor(visit.siteId, visit.visitorId)) {
      await pushFinalizedVisitRealtimeEvent(
        context,
        visit,
        now,
        null,
        "timeout",
        "timeout",
      );
    }
  }
}

async function flushHiddenFallbacks(
  context: IngestFlushContext,
  now: number,
): Promise<void> {
  const rows = context.sqlAll<TimedOutVisitCandidate>(
    `
      SELECT
        visit_id AS visitId,
        site_id AS siteId,
        visitor_id AS visitorId,
        session_id AS sessionId,
        status,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        hidden_at AS hiddenAt,
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
        language,
        screen_width AS screenWidth,
        screen_height AS screenHeight,
        CASE
          WHEN screen_width IS NOT NULL AND screen_height IS NOT NULL
            THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
          ELSE ''
        END AS screenSize,
        latitude,
        longitude
      FROM buffered_visits
      WHERE status = 'hidden_pending'
        AND hidden_at IS NOT NULL
        AND hidden_at <= ?
      LIMIT ?
    `,
    now - HIDDEN_LEAVE_GRACE_MS,
    TIMEOUT_FINALIZE_BATCH_SIZE,
  );
  if (rows.length > 0) {
    context.observability?.info("do.hidden_fallbacks_found");
  }

  for (const visit of rows) {
    const hiddenAt = Math.max(visit.hiddenAt ?? now, visit.startedAt);
    const durationMs = Math.max(0, hiddenAt - visit.startedAt);
    const rowsWritten = context.sqlRun(
      `
        UPDATE buffered_visits
        SET status = 'complete',
            last_activity_at = ?,
            hidden_at = NULL,
            ended_at = ?,
            finalized_at = ?,
            duration_ms = ?,
            duration_source = 'hidden',
            exit_reason = 'hidden_timeout',
            dirty = 1,
            updated_at = ?,
            flush_due_at = CASE
              WHEN flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            next_due_at = CASE
              WHEN flush_due_at IS NULL OR flush_due_at > ? THEN ?
              ELSE flush_due_at
            END,
            buffer_revision = buffer_revision + 1
        WHERE site_id = ? AND visit_id = ? AND status = 'hidden_pending'
      `,
      hiddenAt,
      hiddenAt,
      hiddenAt,
      durationMs,
      toUnixSeconds(now),
      now,
      now,
      now,
      now,
      visit.siteId,
      visit.visitId,
    );
    if (rowsWritten === 0) continue;
    if (!context.hasOpenVisitsForVisitor(visit.siteId, visit.visitorId)) {
      await pushFinalizedVisitRealtimeEvent(
        context,
        visit,
        hiddenAt,
        durationMs,
        "hidden",
        "hidden_timeout",
      );
    }
  }
}

function markVisitRowsFlushed(
  context: IngestFlushContext,
  rows: BufferedVisitFlushRow[],
): void {
  if (rows.length === 0) return;
  const conditions = rows
    .map(() => "(visit_id = ? AND buffer_revision = ?)")
    .join(" OR ");
  const bindings = rows.flatMap((row) => [row.visitId, bufferRevisionOf(row)]);
  const updated = context.sqlRun(
    `UPDATE buffered_visits SET dirty = 0, flush_attempts = 0, last_flush_error = NULL, flush_due_at = NULL, next_due_at = CASE WHEN next_due_at = flush_due_at THEN NULL ELSE next_due_at END WHERE ${conditions}`,
    ...bindings,
  );
  void updated;
  deleteFlushedVisitRows(context, rows);
}

function markVisitRowsFailed(
  context: IngestFlushContext,
  rows: BufferedVisitFlushRow[],
  errorMessage: string,
): void {
  if (rows.length === 0) return;
  const now = Date.now();
  for (const row of rows) {
    const retryAt = now + retryDelayFor(row.flushAttempts);
    const updated = context.sqlRun(
      `UPDATE buffered_visits SET flush_attempts = ?, last_flush_error = ?, flush_due_at = ?, next_due_at = ? WHERE visit_id = ? AND buffer_revision = ?`,
      row.flushAttempts + 1,
      errorMessage,
      retryAt,
      nextDueAtAfterRetry(row, retryAt),
      row.visitId,
      bufferRevisionOf(row),
    );
    void updated;
  }
}

function bufferRevisionOf(row: Partial<FlushBufferFields>): number {
  return row.bufferRevision ?? 0;
}

function retryDelayFor(previousAttempts: number): number {
  const attempt = Number.isFinite(previousAttempts)
    ? Math.max(0, Math.floor(previousAttempts))
    : 0;
  return (
    FLUSH_RETRY_DELAYS_MS[
      Math.min(attempt, FLUSH_RETRY_DELAYS_MS.length - 1)
    ] ?? FLUSH_RETRY_DELAYS_MS[0]
  );
}

function nextDueAtAfterRetry(
  row: Partial<FlushBufferFields>,
  retryAt: number,
): number {
  if (
    row.nextDueAt === undefined ||
    row.nextDueAt === null ||
    row.nextDueAt === row.flushDueAt
  ) {
    return retryAt;
  }
  return Math.min(row.nextDueAt, retryAt);
}

function prepareVisitStatement(
  context: IngestFlushContext,
  row: BufferedVisitRow,
  sitePk: number,
): D1PreparedStatement {
  return context.env.DB.prepare(visitUpsertSql(row.status)).bind(
    ...visitBindings(row, sitePk),
  );
}

function deleteFlushedVisitRows(
  context: IngestFlushContext,
  rows: BufferedVisitFlushRow[],
): void {
  const now = Date.now();
  const cutoffMs = now - FLUSHED_BUFFER_RETENTION_MS;
  const hiddenFallbackCutoffMs = now - VISIT_TIMEOUT_MS;
  const eligibleRows = rows.filter(
    (row) =>
      row.status === "timeout" ||
      visitEndedBeforeRealtimeCutoff(row, cutoffMs, hiddenFallbackCutoffMs),
  );
  if (eligibleRows.length === 0) return;
  const conditions = eligibleRows
    .map(() => "(visit_id = ? AND buffer_revision = ?)")
    .join(" OR ");
  const bindings = eligibleRows.flatMap((row) => [
    row.visitId,
    bufferRevisionOf(row),
  ]);
  const deleted = context.sqlRun(
    `DELETE FROM buffered_visits WHERE ${conditions}`,
    ...bindings,
  );
  void deleted;
  void cutoffMs;
}

function visitEndedBeforeRealtimeCutoff(
  row: Pick<
    BufferedVisitRow,
    | "status"
    | "startedAt"
    | "endedAt"
    | "finalizedAt"
    | "durationSource"
    | "exitReason"
  >,
  cutoffMs: number,
  hiddenFallbackCutoffMs: number,
): boolean {
  if (row.status === "open" || row.status === "hidden_pending") return false;
  const eventAt = row.finalizedAt ?? row.endedAt ?? row.startedAt;
  if (row.durationSource === "hidden" || row.exitReason === "hidden_timeout") {
    return eventAt < hiddenFallbackCutoffMs;
  }
  return eventAt < cutoffMs;
}

async function flushRowsIndividually(
  context: IngestFlushContext,
  visitRows: BufferedVisitRow[],
  eventRows: BufferedCustomEventRow[],
): Promise<void> {
  for (const row of visitRows) {
    await flushVisitRowIndividually(context, row);
  }
  for (const row of eventRows) {
    await flushCustomEventRowIndividually(context, row);
  }
}

async function flushVisitRowIndividually(
  context: IngestFlushContext,
  row: BufferedVisitRow,
): Promise<void> {
  try {
    recordFlushCounter(context, "d1Statements");
    const sitePk = await resolveSitePk(context, row.siteId);
    await context.env.DB.batch([prepareVisitStatement(context, row, sitePk)]);
    recordFlushCounter(context, "flushedVisits");
    markVisitRowsFlushed(context, [row]);
  } catch (error) {
    const message = clampString(
      String(error instanceof Error ? error.message : error),
      400,
    );
    recordFlushCounter(context, "failedStatements");
    context.observability?.error("do.flush.visit_failed");
    markVisitRowsFailed(context, [row], message);
  }
}

async function cleanupOrphanedCustomEvents(
  context: IngestFlushContext,
  now: number,
): Promise<void> {
  const cutoffMs = now - ORPHAN_CUSTOM_EVENT_TIMEOUT_MS;
  const rows = context.sqlAll<{
    eventId: string;
    siteId: string;
    visitId: string;
    bufferRevision?: number;
  }>(
    `
      SELECT
        e.event_id AS eventId,
        e.site_id AS siteId,
        e.visit_id AS visitId,
        e.buffer_revision AS bufferRevision
      FROM buffered_custom_events e
      WHERE e.dirty = 1
        AND e.occurred_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM buffered_visits v
          WHERE v.site_id = e.site_id
            AND v.visit_id = e.visit_id
        )
      ORDER BY e.occurred_at ASC, e.created_at ASC
      LIMIT ?
    `,
    cutoffMs,
    D1_FLUSH_CUSTOM_EVENT_BATCH_SIZE,
  );
  if (rows.length === 0) return;

  const orphanRows: Array<{
    eventId: string;
    bufferRevision?: number;
  }> = [];
  for (const row of rows) {
    const persistedVisit = await context.readPersistedVisitRow(
      row.siteId,
      row.visitId,
    );
    if (persistedVisit) {
      context.insertBufferedVisitRow(persistedVisit);
      continue;
    }
    const localVisit = context.sqlOne<{ ok: number }>(
      `
        SELECT 1 AS ok
        FROM buffered_visits
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
      row.siteId,
      row.visitId,
    );
    if (localVisit) continue;
    orphanRows.push(row);
  }

  if (orphanRows.length === 0) return;
  const conditions = orphanRows
    .map(() => "(event_id = ? AND buffer_revision = ?)")
    .join(" OR ");
  const bindings = orphanRows.flatMap((row) => [
    row.eventId,
    row.bufferRevision ?? 0,
  ]);
  const deleted = context.sqlRun(
    `DELETE FROM buffered_custom_events WHERE ${conditions}`,
    ...bindings,
  );
  void deleted;
  void cutoffMs;
  context.observability?.warn("do.cleanup.orphan_custom_events_deleted");
}
