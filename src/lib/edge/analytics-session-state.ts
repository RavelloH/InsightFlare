import type { SqlWriter } from "./ingest-types";

export interface AnalyticsSessionState {
  siteId: string;
  sessionId: string;
  visitorId: string;
  startedAt: number;
  lastActivityAt: number;
  pageCount: number;
  entryPath: string;
  lastPath: string;
  lastVisitId: string;
  nextDueAt: number;
}

export interface AnalyticsSessionPageviewInput {
  siteId: string;
  sessionId: string;
  visitorId: string;
  startedAt: number;
  pathname: string;
  visitId: string;
  sessionWindowMs: number;
}

export function advanceAnalyticsSession(
  context: SqlWriter,
  input: AnalyticsSessionPageviewInput,
): AnalyticsSessionState {
  const current = context.sqlOne<AnalyticsSessionState>(
    `
      SELECT
        site_id AS siteId,
        session_id AS sessionId,
        visitor_id AS visitorId,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        page_count AS pageCount,
        entry_path AS entryPath,
        last_path AS lastPath,
        last_visit_id AS lastVisitId,
        next_due_at AS nextDueAt
      FROM analytics_sessions
      WHERE session_id = ?
      LIMIT 1
    `,
    input.sessionId,
  );

  if (!current) {
    const inserted = context.sqlRun(
      `
        INSERT INTO analytics_sessions (
          site_id, session_id, visitor_id, started_at, last_activity_at, page_count,
          entry_path, last_path, last_visit_id, next_due_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO NOTHING
      `,
      input.siteId,
      input.sessionId,
      input.visitorId,
      input.startedAt,
      input.startedAt,
      input.pathname,
      input.pathname,
      input.visitId,
      input.startedAt + input.sessionWindowMs,
    );
    void inserted;
    const insertedState = context.sqlOne<AnalyticsSessionState>(
      `
      SELECT
          site_id AS siteId,
          session_id AS sessionId,
          visitor_id AS visitorId,
          started_at AS startedAt,
          last_activity_at AS lastActivityAt,
          page_count AS pageCount,
          entry_path AS entryPath,
          last_path AS lastPath,
          last_visit_id AS lastVisitId,
          next_due_at AS nextDueAt
        FROM analytics_sessions
        WHERE session_id = ?
        LIMIT 1
      `,
      input.sessionId,
    );
    if (insertedState) return insertedState;
  }

  const lastActivityAt = Math.max(
    current?.lastActivityAt ?? input.startedAt,
    input.startedAt,
  );
  context.sqlRun(
    `
      UPDATE analytics_sessions
      SET visitor_id = ?,
          last_activity_at = ?,
          page_count = page_count + 1,
          last_path = ?,
          last_visit_id = ?,
          next_due_at = ?
      WHERE session_id = ?
    `,
    input.visitorId,
    lastActivityAt,
    input.pathname,
    input.visitId,
    lastActivityAt + input.sessionWindowMs,
    input.sessionId,
  );

  const state = context.sqlOne<AnalyticsSessionState>(
    `
      SELECT
        site_id AS siteId,
        session_id AS sessionId,
        visitor_id AS visitorId,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        page_count AS pageCount,
        entry_path AS entryPath,
        last_path AS lastPath,
        last_visit_id AS lastVisitId,
        next_due_at AS nextDueAt
      FROM analytics_sessions
      WHERE session_id = ?
      LIMIT 1
    `,
    input.sessionId,
  );
  if (!state) {
    throw new Error(`Analytics session state disappeared: ${input.sessionId}`);
  }
  return state;
}

export function readDueAnalyticsSessions(
  context: Pick<SqlWriter, "sqlAll">,
  now: number,
): AnalyticsSessionState[] {
  return context.sqlAll<AnalyticsSessionState>(
    `
      SELECT
        site_id AS siteId,
        session_id AS sessionId,
        visitor_id AS visitorId,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt,
        page_count AS pageCount,
        entry_path AS entryPath,
        last_path AS lastPath,
        last_visit_id AS lastVisitId,
        next_due_at AS nextDueAt
      FROM analytics_sessions
      WHERE next_due_at <= ?
      ORDER BY next_due_at ASC, session_id ASC
      LIMIT 100
    `,
    now,
  );
}

export function deleteAnalyticsSession(
  context: Pick<SqlWriter, "sqlRun">,
  sessionId: string,
): void {
  context.sqlRun(
    "DELETE FROM analytics_sessions WHERE session_id = ?",
    sessionId,
  );
}
