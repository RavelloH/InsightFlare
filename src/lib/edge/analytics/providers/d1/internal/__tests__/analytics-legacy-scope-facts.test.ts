import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  gte,
  join,
  lt,
  param,
  project,
  scan,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { schema } from "@/lib/db/schema";
import { buildLegacyScopeFactRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scope-facts";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyScopedPredicateContext,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

const SITE_A = "legacy-facts-a";
const SITE_B = "legacy-facts-b";
const WINDOW = { start: 0, end: 100 } as const;
const SESSION_FACTS = [
  "fact.session_duration_ms",
  "fact.session_views",
  "fact.session_events",
  "fact.session_bounce",
] as const;
const VISITOR_FACTS = [
  "fact.visitor_sessions",
  "fact.visitor_views",
  "fact.visitor_events",
] as const;

let db: DatabaseSync;
let sitePkA: number;
let sitePkB: number;

function pageRow(relation = scan(schema.visits)): AnalyticsLegacyPageRow {
  return {
    relation: relation as unknown as AnalyticsDbRelation,
    sitePk: relation.columns
      .site_pk as unknown as AnalyticsLegacyPageRow["sitePk"],
    rawSiteId: relation.columns
      .site_id as unknown as AnalyticsLegacyPageRow["rawSiteId"],
    visitId: relation.columns
      .visit_id as unknown as AnalyticsLegacyPageRow["visitId"],
    sessionId: relation.columns
      .session_id as unknown as AnalyticsLegacyPageRow["sessionId"],
    visitorId: relation.columns
      .visitor_id as unknown as AnalyticsLegacyPageRow["visitorId"],
    startedAt: relation.columns
      .started_at as unknown as AnalyticsLegacyPageRow["startedAt"],
    pathname: relation.columns
      .pathname as unknown as AnalyticsLegacyPageRow["pathname"],
    durationMs: relation.columns
      .duration_ms as unknown as AnalyticsLegacyPageRow["durationMs"],
    visitColumns: relation.columns,
    filterValues: {},
  };
}

function ownedEventRow(): AnalyticsLegacyEventRow {
  const events = scan(schema.custom_events);
  const visits = scan(schema.visits);
  const owned = join(
    events,
    visits,
    and(
      eq(events.columns.site_pk, visits.columns.site_pk),
      eq(events.columns.visit_id, visits.columns.visit_id),
    ),
  );
  const relation = project(owned, {
    event_pk: owned.columns.left_event_pk,
    event_id: owned.columns.left_event_id,
    site_id: owned.columns.left_site_id,
    site_pk: owned.columns.left_site_pk,
    visit_id: owned.columns.left_visit_id,
    event_name_id: owned.columns.left_event_name_id,
    occurred_at: owned.columns.left_occurred_at,
    session_id: owned.columns.right_session_id,
    visitor_id: owned.columns.right_visitor_id,
  });
  return {
    relation: relation as unknown as AnalyticsDbRelation,
    sitePk: relation.columns
      .site_pk as unknown as AnalyticsLegacyEventRow["sitePk"],
    rawSiteId: relation.columns
      .site_id as unknown as AnalyticsLegacyEventRow["rawSiteId"],
    eventPk: relation.columns
      .event_pk as unknown as AnalyticsLegacyEventRow["eventPk"],
    eventId: relation.columns
      .event_id as unknown as AnalyticsLegacyEventRow["eventId"],
    nameId: relation.columns
      .event_name_id as unknown as AnalyticsLegacyEventRow["nameId"],
    visitId: relation.columns
      .visit_id as unknown as AnalyticsLegacyEventRow["visitId"],
    sessionId: relation.columns
      .session_id as unknown as AnalyticsLegacyEventRow["sessionId"],
    visitorId: relation.columns
      .visitor_id as unknown as AnalyticsLegacyEventRow["visitorId"],
    occurredAt: relation.columns
      .occurred_at as unknown as AnalyticsLegacyEventRow["occurredAt"],
    eventName: param("legacy-event"),
    eventColumns: {},
    ownerVisitColumns: {},
    filterValues: {},
  };
}

function context(): AnalyticsLegacyScopedPredicateContext {
  const allPages = scan(schema.visits);
  const readPagesRelation = filter(
    allPages,
    // Keep the in-window raw Page bag. The event owner below may be outside it.
    // This mirrors the separate Page-start and Event-occurred time windows.
    and(
      gte(allPages.columns.started_at, param(WINDOW.start)),
      lt(allPages.columns.started_at, param(WINDOW.end)),
    ),
  );
  const allEvents = ownedEventRow();
  const readEventsRelation = filter(
    allEvents.relation,
    and(
      gte(allEvents.occurredAt, param(WINDOW.start)),
      lt(allEvents.occurredAt, param(WINDOW.end)),
    ),
  );
  const readPages = pageRow(readPagesRelation as never);
  const readEvents = {
    ...allEvents,
    relation: readEventsRelation as unknown as AnalyticsDbRelation,
    sitePk: readEventsRelation.columns
      .site_pk as AnalyticsLegacyEventRow["sitePk"],
    rawSiteId: readEventsRelation.columns
      .site_id as AnalyticsLegacyEventRow["rawSiteId"],
    eventPk: readEventsRelation.columns
      .event_pk as AnalyticsLegacyEventRow["eventPk"],
    eventId: readEventsRelation.columns
      .event_id as AnalyticsLegacyEventRow["eventId"],
    nameId: readEventsRelation.columns
      .event_name_id as AnalyticsLegacyEventRow["nameId"],
    visitId: readEventsRelation.columns
      .visit_id as AnalyticsLegacyEventRow["visitId"],
    sessionId: readEventsRelation.columns
      .session_id as AnalyticsLegacyEventRow["sessionId"],
    visitorId: readEventsRelation.columns
      .visitor_id as AnalyticsLegacyEventRow["visitorId"],
    occurredAt: readEventsRelation.columns
      .occurred_at as AnalyticsLegacyEventRow["occurredAt"],
  };
  return {
    selection: {} as never,
    storage: {} as never,
    readPages,
    candidatePages: readPages,
    readEvents,
  };
}

function insertPage(input: {
  readonly siteId: string;
  readonly sitePk: number;
  readonly visitId: string;
  readonly visitorId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly durationMs: number | string | null;
}): void {
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, duration_ms, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, '/', 'facts.example', ?, ?)
  `,
  ).run(
    input.visitId,
    input.siteId,
    input.visitorId,
    input.sessionId,
    input.startedAt,
    input.startedAt,
    input.durationMs,
    input.sitePk,
  );
}

function insertEvent(input: {
  readonly eventId: string;
  readonly siteId: string;
  readonly sitePk: number;
  readonly visitId: string;
  readonly occurredAt: number;
}): void {
  db.prepare(
    `
    INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, node_count, value_count
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0)
  `,
  ).run(
    input.eventId,
    input.siteId,
    input.sitePk,
    input.visitId,
    input.occurredAt,
    input.occurredAt,
  );
}

function oldSessionFacts(): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `
    WITH
    eligible_pages AS (
      SELECT * FROM visits WHERE started_at >= ? AND started_at < ?
    ),
    eligible_events AS (
      SELECT ce.site_pk, ce.site_id, v.session_id, v.visitor_id
      FROM custom_events ce
      INNER JOIN visits v
        ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
      WHERE ce.occurred_at >= ? AND ce.occurred_at < ?
    ),
    entities AS (
      SELECT site_pk, site_id, session_id FROM eligible_pages
      WHERE TRIM(COALESCE(session_id, '')) != ''
      UNION
      SELECT site_pk, site_id, session_id FROM eligible_events
      WHERE TRIM(COALESCE(session_id, '')) != ''
    ),
    page_facts AS (
      SELECT site_pk, site_id, session_id,
        SUM(COALESCE(duration_ms, 0)) AS session_duration_ms,
        COUNT(*) AS session_views
      FROM eligible_pages
      WHERE TRIM(COALESCE(session_id, '')) != ''
      GROUP BY site_pk, site_id, session_id
    ),
    event_facts AS (
      SELECT site_pk, site_id, session_id, COUNT(*) AS session_events
      FROM eligible_events
      WHERE TRIM(COALESCE(session_id, '')) != ''
      GROUP BY site_pk, site_id, session_id
    )
    SELECT e.site_pk, e.site_id AS raw_site_id, e.session_id AS entity_id,
      COALESCE(p.session_duration_ms, 0) AS session_duration_ms,
      COALESCE(p.session_views, 0) AS session_views,
      COALESCE(f.session_events, 0) AS session_events,
      CASE WHEN COALESCE(p.session_views, 0) = 1 THEN 1 ELSE 0 END AS session_bounce
    FROM entities e
    LEFT JOIN page_facts p
      ON p.site_pk = e.site_pk AND p.site_id = e.site_id AND p.session_id = e.session_id
    LEFT JOIN event_facts f
      ON f.site_pk = e.site_pk AND f.site_id = e.site_id AND f.session_id = e.session_id
    ORDER BY e.site_pk, e.site_id, e.session_id
  `,
    )
    .all(WINDOW.start, WINDOW.end, WINDOW.start, WINDOW.end) as Record<
    string,
    unknown
  >[];
  return sortFactRows(rows);
}

function oldVisitorFacts(): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `
    WITH
    eligible_pages AS (
      SELECT * FROM visits WHERE started_at >= ? AND started_at < ?
    ),
    eligible_events AS (
      SELECT ce.site_pk, ce.site_id, v.session_id, v.visitor_id
      FROM custom_events ce
      INNER JOIN visits v
        ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
      WHERE ce.occurred_at >= ? AND ce.occurred_at < ?
    ),
    entities AS (
      SELECT site_pk, site_id, visitor_id FROM eligible_pages
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
      UNION
      SELECT site_pk, site_id, visitor_id FROM eligible_events
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
    ),
    page_facts AS (
      SELECT site_pk, site_id, visitor_id, COUNT(*) AS visitor_views
      FROM eligible_pages
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
      GROUP BY site_pk, site_id, visitor_id
    ),
    event_facts AS (
      SELECT site_pk, site_id, visitor_id, COUNT(*) AS visitor_events
      FROM eligible_events
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
      GROUP BY site_pk, site_id, visitor_id
    ),
    session_evidence AS (
      SELECT site_pk, site_id, visitor_id, session_id FROM eligible_pages
      WHERE TRIM(COALESCE(visitor_id, '')) != '' AND TRIM(COALESCE(session_id, '')) != ''
      UNION
      SELECT site_pk, site_id, visitor_id, session_id FROM eligible_events
      WHERE TRIM(COALESCE(visitor_id, '')) != '' AND TRIM(COALESCE(session_id, '')) != ''
    ),
    session_facts AS (
      SELECT site_pk, site_id, visitor_id, COUNT(DISTINCT session_id) AS visitor_sessions
      FROM session_evidence
      GROUP BY site_pk, site_id, visitor_id
    )
    SELECT e.site_pk, e.site_id AS raw_site_id, e.visitor_id AS entity_id,
      COALESCE(s.visitor_sessions, 0) AS visitor_sessions,
      COALESCE(p.visitor_views, 0) AS visitor_views,
      COALESCE(f.visitor_events, 0) AS visitor_events
    FROM entities e
    LEFT JOIN session_facts s
      ON s.site_pk = e.site_pk AND s.site_id = e.site_id AND s.visitor_id = e.visitor_id
    LEFT JOIN page_facts p
      ON p.site_pk = e.site_pk AND p.site_id = e.site_id AND p.visitor_id = e.visitor_id
    LEFT JOIN event_facts f
      ON f.site_pk = e.site_pk AND f.site_id = e.site_id AND f.visitor_id = e.visitor_id
    ORDER BY e.site_pk, e.site_id, e.visitor_id
  `,
    )
    .all(WINDOW.start, WINDOW.end, WINDOW.start, WINDOW.end) as Record<
    string,
    unknown
  >[];
  return sortFactRows(rows);
}

function sortFactRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.sort(
    (left, right) =>
      Number(left.site_pk) - Number(right.site_pk) ||
      String(left.raw_site_id).localeCompare(String(right.raw_site_id)) ||
      String(left.entity_id).localeCompare(String(right.entity_id)),
  );
}

async function loweredFacts(
  entityKind: "session" | "visitor",
  requiredFacts: readonly string[],
): Promise<Record<string, unknown>[]> {
  const facts = buildLegacyScopeFactRelation({
    context: context(),
    entityKind,
    requiredFacts,
  });
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    compileD1Query(facts.relation),
  );
  return result.results
    .map((row) => row as Record<string, unknown>)
    .sort(
      (left, right) =>
        Number(left.site_pk) - Number(right.site_pk) ||
        String(left.raw_site_id).localeCompare(String(right.raw_site_id)) ||
        String(left.entity_id).localeCompare(String(right.entity_id)),
    );
}

describe("legacy scope-fact relation", () => {
  beforeAll(() => {
    db = createMigratedDatabase();
    const identity = db.prepare(
      "INSERT INTO site_identities (site_id) VALUES (?)",
    );
    identity.run(SITE_A);
    identity.run(SITE_B);
    sitePkA = (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_A) as { site_pk: number }
    ).site_pk;
    sitePkB = (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_B) as { site_pk: number }
    ).site_pk;
    db.prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, 'legacy-event', 100, ?)",
    ).run(SITE_A, sitePkA);
    db.prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, 'legacy-event', 100, ?)",
    ).run(SITE_B, sitePkB);

    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "a1",
      visitorId: "visitor-x",
      sessionId: "session-x",
      startedAt: 10,
      durationMs: 5,
    });
    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "a2",
      visitorId: "visitor-x",
      sessionId: "session-x",
      startedAt: 20,
      durationMs: "not-a-number",
    });
    insertPage({
      siteId: "raw-A-alt",
      sitePk: sitePkA,
      visitId: "a3",
      visitorId: "visitor-x",
      sessionId: "session-x",
      startedAt: 30,
      durationMs: 7,
    });
    insertPage({
      siteId: "raw-B",
      sitePk: sitePkB,
      visitId: "b1",
      visitorId: "visitor-x",
      sessionId: "session-x",
      startedAt: 40,
      durationMs: 11,
    });
    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "space-session",
      visitorId: "  ",
      sessionId: "  ",
      startedAt: 50,
      durationMs: 3,
    });
    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "empty-ids",
      visitorId: "",
      sessionId: "",
      startedAt: 60,
      durationMs: 1,
    });
    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "nbsp-session",
      visitorId: " ",
      sessionId: " ",
      startedAt: 70,
      durationMs: 2,
    });
    insertPage({
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "event-owner",
      visitorId: "visitor-event-only",
      sessionId: "session-event-only",
      startedAt: 500,
      durationMs: 99,
    });

    insertEvent({
      eventId: "event-a1",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "a1",
      occurredAt: 11,
    });
    insertEvent({
      eventId: "event-a2",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "a1",
      occurredAt: 12,
    });
    insertEvent({
      eventId: "event-alt",
      siteId: "raw-A-alt",
      sitePk: sitePkA,
      visitId: "a3",
      occurredAt: 13,
    });
    insertEvent({
      eventId: "event-b",
      siteId: "raw-B",
      sitePk: sitePkB,
      visitId: "b1",
      occurredAt: 14,
    });
    insertEvent({
      eventId: "event-space",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "space-session",
      occurredAt: 15,
    });
    insertEvent({
      eventId: "event-nbsp",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "nbsp-session",
      occurredAt: 16,
    });
    insertEvent({
      eventId: "event-only-1",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "event-owner",
      occurredAt: 17,
    });
    insertEvent({
      eventId: "event-only-2",
      siteId: "raw-A",
      sitePk: sitePkA,
      visitId: "event-owner",
      occurredAt: 18,
    });
  });

  afterAll(() => db.close());

  it("matches the frozen seven-fact SQL with triple grouping and raw SQLite sums", async () => {
    const oldSessions = oldSessionFacts();
    const oldVisitors = oldVisitorFacts();
    const newSessions = await loweredFacts("session", SESSION_FACTS);
    const newVisitors = await loweredFacts("visitor", VISITOR_FACTS);

    expect(newSessions).toEqual(oldSessions);
    expect(newVisitors).toEqual(oldVisitors);
    expect(newSessions).toContainEqual({
      site_pk: sitePkA,
      raw_site_id: "raw-A",
      entity_id: "session-x",
      session_duration_ms: 5,
      session_views: 2,
      session_events: 2,
      session_bounce: 0,
    });
    expect(newSessions).toContainEqual({
      site_pk: sitePkA,
      raw_site_id: "raw-A-alt",
      entity_id: "session-x",
      session_duration_ms: 7,
      session_views: 1,
      session_events: 1,
      session_bounce: 1,
    });
    expect(newSessions).toContainEqual({
      site_pk: sitePkA,
      raw_site_id: "raw-A",
      entity_id: "session-event-only",
      session_duration_ms: 0,
      session_views: 0,
      session_events: 2,
      session_bounce: 0,
    });
    expect(
      newVisitors.find((row) => row.entity_id === "visitor-event-only"),
    ).toMatchObject({
      visitor_sessions: 1,
      visitor_views: 0,
      visitor_events: 2,
    });
    expect(newSessions.some((row) => row.entity_id === "  ")).toBe(false);
    expect(newVisitors.some((row) => row.entity_id === "  ")).toBe(false);
    expect(newSessions.some((row) => row.entity_id === " ")).toBe(true);
    expect(newVisitors.some((row) => row.entity_id === " ")).toBe(true);
  });

  it("leaves integer SUM overflow behavior to SQLite", async () => {
    insertPage({
      siteId: "raw-overflow",
      sitePk: sitePkA,
      visitId: "overflow-a",
      visitorId: "visitor-overflow",
      sessionId: "session-overflow",
      startedAt: 80,
      durationMs: "9223372036854775807",
    });
    insertPage({
      siteId: "raw-overflow",
      sitePk: sitePkA,
      visitId: "overflow-b",
      visitorId: "visitor-overflow",
      sessionId: "session-overflow",
      startedAt: 81,
      durationMs: "1",
    });
    const old = () =>
      db
        .prepare(
          `
      SELECT SUM(COALESCE(duration_ms, 0)) AS duration_sum
      FROM visits
      WHERE site_pk = ? AND site_id = 'raw-overflow' AND session_id = 'session-overflow'
    `,
        )
        .get(sitePkA);
    expect(old).toThrow(/overflow/iu);
    await expect(
      loweredFacts("session", ["fact.session_duration_ms"]),
    ).rejects.toThrow(/overflow/iu);
  });

  it("rejects a Visitor fact requested from the Session fact relation", () => {
    expect(() =>
      buildLegacyScopeFactRelation({
        context: context(),
        entityKind: "session",
        requiredFacts: ["fact.visitor_sessions"],
      }),
    ).toThrow(
      "Legacy session scope facts do not support fact.visitor_sessions.",
    );
  });
});
