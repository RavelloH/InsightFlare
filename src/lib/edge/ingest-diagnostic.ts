import {
  DIAGNOSTIC_HARD_AGE_MS,
  DIAGNOSTIC_STALE_MS,
  DIAGNOSTIC_STUCK_FLUSH_ATTEMPTS,
  ORPHAN_CUSTOM_EVENT_TIMEOUT_MS,
  VISIT_TIMEOUT_MS,
} from "./ingest-constants";
import { jsonResponse } from "./ingest-normalize";
import { getEarliestDueWork } from "./ingest-scheduler";
import type { SqlReader } from "./ingest-types";

interface DiagnosticContext extends SqlReader {
  getAlarm(): Promise<number | null | undefined>;
}

function toCount(input: unknown): number {
  const value = Number(input ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function toNullableNumber(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

export async function handleIngestDiagnostic(
  context: DiagnosticContext,
): Promise<Response> {
  const now = Date.now();

  const totalRow = context.sqlOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM buffered_visits",
  );
  const visitsTotal = totalRow ? Number(totalRow.c ?? 0) : 0;

  const statusRows = context.sqlAll<{ status: string; c: number }>(
    "SELECT status, COUNT(*) AS c FROM buffered_visits GROUP BY status",
  );
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.c ?? 0);
  }

  const openRow = context.sqlOne<{
    total: number;
    stale: number;
    timedOut: number;
    hardAged: number;
    futureSkewed: number;
    oldestStartedAt: number | null;
    newestActivityAt: number | null;
    futureMaxActivityAt: number | null;
  }>(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS stale,
        SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS timedOut,
        SUM(CASE WHEN ? - started_at > ? THEN 1 ELSE 0 END) AS hardAged,
        SUM(CASE WHEN last_activity_at > ? THEN 1 ELSE 0 END) AS futureSkewed,
        MIN(started_at) AS oldestStartedAt,
        MAX(last_activity_at) AS newestActivityAt,
        MAX(CASE WHEN last_activity_at > ? THEN last_activity_at END) AS futureMaxActivityAt
      FROM buffered_visits
      WHERE status = 'open'
    `,
    now,
    DIAGNOSTIC_STALE_MS,
    now,
    VISIT_TIMEOUT_MS,
    now,
    DIAGNOSTIC_HARD_AGE_MS,
    now,
    now,
  );

  const dirtyVisitRow = context.sqlOne<{
    total: number;
    stuck: number;
    maxAttempts: number;
  }>(
    `
      SELECT
        SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN dirty = 1 AND flush_attempts >= ? THEN 1 ELSE 0 END) AS stuck,
        MAX(flush_attempts) AS maxAttempts
      FROM buffered_visits
    `,
    DIAGNOSTIC_STUCK_FLUSH_ATTEMPTS,
  );

  const customEventRow = context.sqlOne<{
    total: number;
    dirty: number;
    stuck: number;
    maxAttempts: number;
    oldestOccurredAt: number | null;
  }>(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END) AS dirty,
        SUM(CASE WHEN dirty = 1 AND flush_attempts >= ? THEN 1 ELSE 0 END) AS stuck,
        MAX(flush_attempts) AS maxAttempts,
        MIN(CASE WHEN dirty = 1 THEN occurred_at END) AS oldestOccurredAt
      FROM buffered_custom_events
    `,
    DIAGNOSTIC_STUCK_FLUSH_ATTEMPTS,
  );

  let alarmAt: number | null = null;
  try {
    const value = await context.getAlarm();
    alarmAt = typeof value === "number" ? value : null;
  } catch {
    alarmAt = null;
  }
  const nextDue = getEarliestDueWork(context);

  return jsonResponse({
    ok: true,
    snapshotAt: now,
    thresholds: {
      staleMs: DIAGNOSTIC_STALE_MS,
      timeoutMs: VISIT_TIMEOUT_MS,
      orphanCustomEventTimeoutMs: ORPHAN_CUSTOM_EVENT_TIMEOUT_MS,
      hardAgedMs: DIAGNOSTIC_HARD_AGE_MS,
      stuckFlushAttempts: DIAGNOSTIC_STUCK_FLUSH_ATTEMPTS,
    },
    visits: {
      total: visitsTotal,
      byStatus,
      open: {
        total: toCount(openRow?.total),
        stale: toCount(openRow?.stale),
        timedOut: toCount(openRow?.timedOut),
        hardAged: toCount(openRow?.hardAged),
        futureSkewed: toCount(openRow?.futureSkewed),
        oldestStartedAt: toNullableNumber(openRow?.oldestStartedAt),
        newestActivityAt: toNullableNumber(openRow?.newestActivityAt),
        futureMaxActivityAt: toNullableNumber(openRow?.futureMaxActivityAt),
      },
      dirty: {
        total: toCount(dirtyVisitRow?.total),
        stuck: toCount(dirtyVisitRow?.stuck),
        maxFlushAttempts: toCount(dirtyVisitRow?.maxAttempts),
      },
    },
    customEvents: {
      total: toCount(customEventRow?.total),
      dirty: toCount(customEventRow?.dirty),
      stuck: toCount(customEventRow?.stuck),
      maxFlushAttempts: toCount(customEventRow?.maxAttempts),
      oldestOccurredAt: toNullableNumber(customEventRow?.oldestOccurredAt),
    },
    alarm: {
      scheduledAt: alarmAt,
      nextDueAt: nextDue.nextDueAt,
      nextDueKind: nextDue.reason,
      nextDueEntity: nextDue.entity,
    },
  });
}
