import { HIDDEN_LEAVE_GRACE_MS, VISIT_TIMEOUT_MS } from "./ingest-constants";
import type { SqlReader } from "./ingest-types";

export type ScheduleReason =
  "flush" | "hidden_fallback" | "visit_timeout" | "session_timeout";

export interface NextDueWork {
  nextDueAt: number | null;
  reason: ScheduleReason | null;
  entity: "visit" | "custom_event" | "session" | null;
}

interface ScheduledVisitRow {
  nextDueAt: number | null;
  flushDueAt: number | null;
  dirty: number;
  status: string;
  lastActivityAt: number | null;
  hiddenAt: number | null;
  visitId: string;
}

interface ScheduledEventRow {
  nextDueAt: number | null;
  flushDueAt: number | null;
  eventId: string;
}

interface ScheduledSessionRow {
  nextDueAt: number | null;
  sessionId: string;
}

export function lifecycleDueAt(
  status: string,
  lastActivityAt: number | null,
  hiddenAt: number | null,
): number | null {
  if (status === "open" && lastActivityAt !== null) {
    return lastActivityAt + VISIT_TIMEOUT_MS;
  }
  if (status === "hidden_pending") {
    return (
      (hiddenAt ?? lastActivityAt ?? 0) +
      (hiddenAt === null ? VISIT_TIMEOUT_MS : HIDDEN_LEAVE_GRACE_MS)
    );
  }
  return null;
}

export function effectiveNextDueAt(
  flushDueAt: number | null,
  lifecycleDue: number | null,
): number | null {
  if (flushDueAt === null) return lifecycleDue;
  if (lifecycleDue === null) return flushDueAt;
  return Math.min(flushDueAt, lifecycleDue);
}

function classifyVisitReason(row: ScheduledVisitRow): ScheduleReason {
  const lifecycle = lifecycleDueAt(
    row.status,
    row.lastActivityAt,
    row.hiddenAt,
  );
  // Flush wins ties so diagnostics remain deterministic.
  if (
    row.dirty === 1 &&
    row.flushDueAt !== null &&
    row.nextDueAt === row.flushDueAt &&
    (lifecycle === null || row.flushDueAt <= lifecycle)
  ) {
    return "flush";
  }
  if (row.status === "hidden_pending") return "hidden_fallback";
  if (row.status === "open") return "visit_timeout";
  return "flush";
}

export function getEarliestDueWork(
  context: Pick<SqlReader, "sqlOne">,
): NextDueWork {
  const visit = context.sqlOne<ScheduledVisitRow>(
    `
      SELECT
        next_due_at AS nextDueAt,
        flush_due_at AS flushDueAt,
        dirty,
        status,
        last_activity_at AS lastActivityAt,
        hidden_at AS hiddenAt,
        visit_id AS visitId
      FROM buffered_visits
      WHERE next_due_at IS NOT NULL
      ORDER BY next_due_at ASC, visit_id ASC
      LIMIT 1
    `,
  );
  const event = context.sqlOne<ScheduledEventRow>(
    `
      SELECT
        next_due_at AS nextDueAt,
        flush_due_at AS flushDueAt,
        event_id AS eventId
      FROM buffered_custom_events
      WHERE next_due_at IS NOT NULL
      ORDER BY next_due_at ASC, event_id ASC
      LIMIT 1
    `,
  );
  const sessionRow = context.sqlOne<ScheduledSessionRow>(
    `
      SELECT
        next_due_at AS nextDueAt,
        session_id AS sessionId
      FROM analytics_sessions
      ORDER BY next_due_at ASC, session_id ASC
      LIMIT 1
    `,
  );

  const session = sessionRow?.sessionId ? sessionRow : null;

  if (!visit && !event && !session) {
    return { nextDueAt: null, reason: null, entity: null };
  }
  if (!event && !session) {
    return {
      nextDueAt: visit!.nextDueAt ?? null,
      reason: classifyVisitReason(visit!),
      entity: "visit",
    };
  }
  if (
    visit &&
    (visit.nextDueAt ?? Infinity) <= (event?.nextDueAt ?? Infinity) &&
    (visit.nextDueAt ?? Infinity) <= (session?.nextDueAt ?? Infinity)
  ) {
    return {
      nextDueAt: visit.nextDueAt ?? null,
      reason: classifyVisitReason(visit),
      entity: "visit",
    };
  }
  if (
    session &&
    (session.nextDueAt ?? Infinity) <= (event?.nextDueAt ?? Infinity)
  ) {
    return {
      nextDueAt: session.nextDueAt ?? null,
      reason: "session_timeout",
      entity: "session",
    };
  }
  return {
    nextDueAt: event!.nextDueAt ?? null,
    reason: "flush",
    entity: "custom_event",
  };
}
