import type { TrafficVisitSnapshot } from "./analytics-engine/traffic-writer";
import {
  deleteAnalyticsSession,
  readDueAnalyticsSessions,
} from "./analytics-session-state";
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
import {
  visitBindings,
  visitDetailBindings,
  visitDetailsUpdateSql,
  visitStateUpsertSql,
} from "./ingest-sql";
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

// A visit flush is a two-statement D1 group. Keep the existing D1 batch and
// alarm budgets expressed in physical statements rather than buffered rows.
const VISIT_FLUSH_STATEMENT_GROUP_SIZE = 2;
const VISIT_FLUSH_ROW_BATCH_SIZE = Math.max(
  1,
  Math.floor(D1_FLUSH_BATCH_SIZE / VISIT_FLUSH_STATEMENT_GROUP_SIZE),
);
const VISIT_CLEANUP_META_KEY = "buffered_visits_cleanup_due_at";
const VISIT_CLEANUP_META_VERSION = 1;
// The CAS delete expands to four bound variables per candidate. Keep the
// batch below the Durable Object SQLite host-parameter limit while retaining
// a bounded cleanup pass.
const VISIT_CLEANUP_BATCH_SIZE = 20;
const VISIT_CLEANUP_RETRY_MS = 60 * 1000;

interface VisitCleanupMetadataRow {
  metadataValue?: number | null;
}

interface VisitCleanupCandidate {
  visitId: string;
  bufferRevision: number;
}

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
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
}

function trafficVisitSnapshot(
  visit: TimedOutVisitCandidate,
): TrafficVisitSnapshot {
  return {
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
    perfTtfbMs: visit.perfTtfbMs,
    perfFcpMs: visit.perfFcpMs,
    perfLcpMs: visit.perfLcpMs,
    perfCls: visit.perfCls,
    perfInpMs: visit.perfInpMs,
  };
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
          user_id AS userId,
          user_name AS userName,
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
      VISIT_FLUSH_ROW_BATCH_SIZE,
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
        const preparedVisitGroups = visitRows.map((row) => {
          const sitePk = sitePkById.get(row.siteId);
          if (sitePk === undefined) {
            throw new Error(`Missing site identity for ${row.siteId}`);
          }
          return prepareVisitStatements(context, row, sitePk);
        });
        const preparedVisits = preparedVisitGroups.flat();
        await context.env.DB.batch(preparedVisits);
        recordFlushCounter(context, "flushedVisits", visitRows.length);
        markVisitRowsFlushed(context, visitRows);
      } catch (error) {
        void error;
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
      visitRows.length < VISIT_FLUSH_ROW_BATCH_SIZE &&
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
  const storedCleanupDueAt = context.getVisitCleanupDueAt?.();
  const cleanupDueAt =
    storedCleanupDueAt === undefined
      ? readVisitCleanupDueAt(context)
      : storedCleanupDueAt;
  const normalizedCleanupDueAt = cleanupDueAt ?? null;
  const nextCleanupDueAt =
    normalizedCleanupDueAt === null
      ? findEarliestVisitCleanupDueAt(context, now)
      : normalizedCleanupDueAt;
  if (normalizedCleanupDueAt === null && nextCleanupDueAt !== null) {
    writeVisitCleanupDueAt(context, nextCleanupDueAt);
  } else if (normalizedCleanupDueAt === null && nextCleanupDueAt === null) {
    context.setVisitCleanupDueAt?.(null);
  }

  let deletedVisits = 0;
  if (nextCleanupDueAt !== null && nextCleanupDueAt <= now) {
    const candidates = context.sqlAll<VisitCleanupCandidate>(
      `
        SELECT visit_id AS visitId, buffer_revision AS bufferRevision
        FROM buffered_visits
        WHERE ${visitCleanupEligibilitySql()}
        ORDER BY COALESCE(finalized_at, ended_at, started_at) ASC, visit_id ASC
        LIMIT ?
      `,
      hiddenFallbackCutoff,
      visitCutoff,
      VISIT_CLEANUP_BATCH_SIZE,
    );
    if (candidates.length > 0) {
      const conditions = candidates
        .map(
          () =>
            "(visit_id = ? AND buffer_revision = ? AND dirty = 0 AND (status = 'timeout' OR (status NOT IN ('open', 'hidden_pending') AND ((COALESCE(duration_source, '') = 'hidden' OR COALESCE(exit_reason, '') = 'hidden_timeout') AND COALESCE(finalized_at, ended_at, started_at) < ?) OR (NOT (COALESCE(duration_source, '') = 'hidden' OR COALESCE(exit_reason, '') = 'hidden_timeout') AND COALESCE(finalized_at, ended_at, started_at) < ?))))",
        )
        .join(" OR ");
      const bindings = candidates.flatMap((candidate) => [
        candidate.visitId,
        candidate.bufferRevision,
        hiddenFallbackCutoff,
        visitCutoff,
      ]);
      deletedVisits = context.sqlRun(
        `DELETE FROM buffered_visits WHERE ${conditions}`,
        ...bindings,
      );
    }
    const recomputedDueAt = findEarliestVisitCleanupDueAt(context, now);
    const nextDueAt =
      recomputedDueAt === null
        ? null
        : candidates.length >= VISIT_CLEANUP_BATCH_SIZE &&
            recomputedDueAt <= now
          ? Math.min(recomputedDueAt, now + VISIT_CLEANUP_RETRY_MS)
          : recomputedDueAt;
    writeVisitCleanupDueAt(context, nextDueAt);
  }
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

function visitCleanupEligibilitySql(): string {
  return `
    dirty = 0
    AND (
      status = 'timeout'
      OR (
        status NOT IN ('open', 'hidden_pending')
        AND (
          (COALESCE(duration_source, '') = 'hidden'
            OR COALESCE(exit_reason, '') = 'hidden_timeout')
          AND COALESCE(finalized_at, ended_at, started_at) < ?
        )
        OR (
          NOT (COALESCE(duration_source, '') = 'hidden'
            OR COALESCE(exit_reason, '') = 'hidden_timeout')
          AND COALESCE(finalized_at, ended_at, started_at) < ?
        )
      )
    )
  `;
}

function readVisitCleanupDueAt(
  context: IngestFlushContext,
): number | null | undefined {
  const row = context.sqlOne<VisitCleanupMetadataRow>(
    `
      SELECT metadata_value AS metadataValue
      FROM ingest_schema_metadata
      WHERE metadata_key = ? AND version = ?
      LIMIT 1
    `,
    VISIT_CLEANUP_META_KEY,
    VISIT_CLEANUP_META_VERSION,
  );
  if (!row) return null;
  const value = row.metadataValue;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function writeVisitCleanupDueAt(
  context: IngestFlushContext,
  dueAt: number | null,
): void {
  context.sqlRun(
    `
      INSERT INTO ingest_schema_metadata (
        metadata_key, version, metadata_value
      ) VALUES (?, ?, ?)
      ON CONFLICT(metadata_key) DO UPDATE SET
        version = excluded.version,
        metadata_value = excluded.metadata_value
    `,
    VISIT_CLEANUP_META_KEY,
    VISIT_CLEANUP_META_VERSION,
    dueAt,
  );
  context.setVisitCleanupDueAt?.(dueAt);
}

function findEarliestVisitCleanupDueAt(
  context: IngestFlushContext,
  now: number,
): number | null {
  const row = context.sqlOne<{ cleanupDueAt: number | null }>(
    `
      SELECT MIN(
        CASE
          WHEN status = 'timeout' THEN ?
          WHEN COALESCE(duration_source, '') = 'hidden'
            OR COALESCE(exit_reason, '') = 'hidden_timeout'
            THEN COALESCE(finalized_at, ended_at, started_at) + ?
          ELSE COALESCE(finalized_at, ended_at, started_at) + ?
        END
      ) AS cleanupDueAt
      FROM buffered_visits
      WHERE dirty = 0
        AND status NOT IN ('open', 'hidden_pending')
    `,
    now,
    VISIT_TIMEOUT_MS,
    FLUSHED_BUFFER_RETENTION_MS,
  );
  const value = row?.cleanupDueAt;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
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
        longitude,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
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
    context.writeTrafficVisitFinalizedFact?.({
      visit: trafficVisitSnapshot(visit),
      receivedAt: now,
      endedAt: now,
      durationMs: null,
      durationSource: "timeout",
      exitReason: "timeout",
    });
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
        longitude,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
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
    context.writeTrafficVisitFinalizedFact?.({
      visit: trafficVisitSnapshot(visit),
      receivedAt: now,
      endedAt: hiddenAt,
      durationMs,
      durationSource: "hidden",
      exitReason: "hidden_timeout",
    });
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
  flushExpiredAnalyticsSessions(context, now);
}

function flushExpiredAnalyticsSessions(
  context: IngestFlushContext,
  now: number,
): void {
  const sessions = readDueAnalyticsSessions(context, now);
  for (const session of sessions) {
    const lastVisit = context.sqlOne<{
      title: string;
      hostname: string;
      referrerHost: string;
      utmSource: string;
      utmMedium: string;
      utmCampaign: string;
      browser: string;
      browserVersion: string;
      os: string;
      osVersion: string;
      language: string;
      region: string;
      city: string;
      timezone: string;
      asOrganization: string;
      latitude: number | null;
      longitude: number | null;
      screenWidth: number | null;
      screenHeight: number | null;
    }>(
      `
        SELECT title, hostname, referrer_host AS referrerHost,
               utm_source AS utmSource, utm_medium AS utmMedium,
               utm_campaign AS utmCampaign, browser,
               browser_version AS browserVersion, os,
               os_version AS osVersion, language, region, city, timezone,
               as_organization AS asOrganization, latitude, longitude,
               screen_width AS screenWidth, screen_height AS screenHeight
        FROM buffered_visits
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
      session.siteId,
      session.lastVisitId,
    );
    context.writeTrafficSessionEndedFact?.({
      ...session,
      receivedAt: now,
      endedAt: Math.max(now, session.lastActivityAt),
      lastVisit: lastVisit ?? undefined,
    });
    deleteAnalyticsSession(context, session.sessionId);
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
    `
      UPDATE buffered_visits
      SET
        dirty = 0,
        flush_attempts = 0,
        last_flush_error = NULL,
        flush_due_at = NULL,
        next_due_at = CASE
          WHEN status = 'open' THEN last_activity_at + ${VISIT_TIMEOUT_MS}
          WHEN status = 'hidden_pending' THEN
            COALESCE(hidden_at, last_activity_at) +
            CASE
              WHEN hidden_at IS NULL THEN ${VISIT_TIMEOUT_MS}
              ELSE ${HIDDEN_LEAVE_GRACE_MS}
            END
          ELSE NULL
        END
      WHERE ${conditions}
    `,
    ...bindings,
  );
  void updated;
  scheduleVisitCleanupForRows(context, rows, Date.now());
}

function scheduleVisitCleanupForRows(
  context: IngestFlushContext,
  rows: readonly BufferedVisitFlushRow[],
  now: number,
): void {
  let candidateDueAt: number | null = null;
  for (const row of rows) {
    if (row.status === "open" || row.status === "hidden_pending") continue;
    const eventAt = row.finalizedAt ?? row.endedAt ?? row.startedAt;
    const dueAt =
      row.status === "timeout"
        ? now
        : eventAt +
          (row.durationSource === "hidden" ||
          row.exitReason === "hidden_timeout"
            ? VISIT_TIMEOUT_MS
            : FLUSHED_BUFFER_RETENTION_MS);
    candidateDueAt =
      candidateDueAt === null ? dueAt : Math.min(candidateDueAt, dueAt);
  }
  if (candidateDueAt === null) return;

  const knownDueAt = context.getVisitCleanupDueAt?.();
  const currentDueAt =
    knownDueAt === undefined ? readVisitCleanupDueAt(context) : knownDueAt;
  const normalizedCurrentDueAt = currentDueAt ?? null;
  if (
    normalizedCurrentDueAt !== null &&
    normalizedCurrentDueAt <= candidateDueAt
  )
    return;
  writeVisitCleanupDueAt(context, candidateDueAt);
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

function prepareVisitStatements(
  context: IngestFlushContext,
  row: BufferedVisitRow,
  sitePk: number,
): D1PreparedStatement[] {
  return [
    context.env.DB.prepare(visitStateUpsertSql(row.status)).bind(
      ...visitBindings(row, sitePk),
    ),
    context.env.DB.prepare(visitDetailsUpdateSql(row.status)).bind(
      ...visitDetailBindings(row),
    ),
  ];
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
    const sitePk = await resolveSitePk(context, row.siteId);
    await context.env.DB.batch(prepareVisitStatements(context, row, sitePk));
    recordFlushCounter(context, "flushedVisits");
    markVisitRowsFlushed(context, [row]);
  } catch (error) {
    const message = clampString(
      String(error instanceof Error ? error.message : error),
      400,
    );
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
