import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildSessionAggregationSql,
  buildVisitorAggregationSql,
} from "@/lib/edge/analytics/providers/d1/internal/journey-aggregation-sql";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  querySessionsFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  queryGeoPointAggregate,
  queryGeoPointsFromD1,
  queryJourneyEventsForDetailFromD1,
  queryJourneyEventsFromD1,
  querySessionDetailFromD1,
  querySessionLocationPointsFromD1,
  querySessionsForDetailFromD1,
  queryVisitorAggregate,
  queryVisitorDetailFromD1,
  queryVisitorForDetailFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  handleSessionDetailContract as handleSessionDetail,
  handleSessionsContract as handleSessions,
  handleVisitorDetailContract as handleVisitorDetail,
  handleVisitorsContract as handleVisitors,
} from "@/lib/edge/analytics/providers/d1/internal/journeys-contract-adapter";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";

type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const siteId = "site-journey";
const baseMs = Date.UTC(2026, 0, 1);

function queryWindow(): QueryWindow {
  return {
    startMs: baseMs,
    endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
    nowMs: baseMs + 24 * 60 * 60 * 1000,
    timeZone: "UTC",
  };
}

function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return { results: pendingResults.shift() ?? [] };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
  };
}

function createSqliteDetailEnv(): {
  env: Env;
  calls: QueryCall[];
  database: DatabaseSync;
  close: () => void;
  explain: (call: QueryCall) => string[];
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0008_rebuild_analytics.sql",
    "migrations/0013_add_visit_performance_metrics.sql",
    "migrations/0017_structured_custom_events.sql",
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  database.exec(`
    CREATE TABLE site_identities (
      site_pk INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL UNIQUE
    );
    INSERT INTO site_identities (site_pk, site_id) VALUES (1, '${siteId}');

    ALTER TABLE visits ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_event_names ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_events ADD COLUMN site_pk INTEGER;

    CREATE TRIGGER test_visits_site_pk
    AFTER INSERT ON visits
    BEGIN
      UPDATE visits SET site_pk = 1 WHERE visit_id = NEW.visit_id;
    END;
    CREATE TRIGGER test_custom_event_names_site_pk
    AFTER INSERT ON custom_event_names
    BEGIN
      UPDATE custom_event_names SET site_pk = 1 WHERE id = NEW.id;
    END;
    CREATE TRIGGER test_custom_events_site_pk
    AFTER INSERT ON custom_events
    BEGIN
      UPDATE custom_events SET site_pk = 1 WHERE event_pk = NEW.event_pk;
    END;

    CREATE INDEX idx_visits_site_pk_visitor_started_at
      ON visits(site_pk, visitor_id, started_at);
    CREATE INDEX idx_visits_site_pk_session_started_at
      ON visits(site_pk, session_id, started_at);
    CREATE INDEX idx_custom_events_site_pk_visit_time
      ON custom_events(site_pk, visit_id, occurred_at, event_pk);
  `);
  const calls: QueryCall[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: QueryBinding[]) => {
          const call = { sql, bindings };
          calls.push(call);
          return {
            all: async () => ({
              results: database.prepare(sql).all(...bindings) as D1Row[],
            }),
          };
        },
      }),
    } as unknown as D1Database,
  } as Env;
  return {
    env,
    calls,
    database,
    close: () => database.close(),
    explain: (call) =>
      database
        .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
        .all(...call.bindings)
        .map((row) => String((row as { detail?: unknown }).detail ?? "")),
  };
}

function visitBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.startMs, window.endExclusiveMs];
}

function eventBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.startMs, window.endExclusiveMs];
}

function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

function visitorRow(overrides: D1Row = {}): D1Row {
  return {
    visitorId: "visitor-1",
    sessionId: "session-1",
    firstSeenAt: baseMs,
    lastSeenAt: baseMs + 60_000,
    views: 3,
    sessions: 2,
    events: 1,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    ...overrides,
  };
}

function sessionRow(overrides: D1Row = {}): D1Row {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: baseMs,
    endedAt: baseMs + 60_000,
    totalDurationMs: 60_000,
    active: 0,
    views: 2,
    events: 1,
    bounce: 0,
    entryPath: "/home",
    exitPath: "/pricing",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 120,
    perfFcpMs: 300,
    perfLcpMs: 1200,
    perfCls: 0.02,
    perfInpMs: 90,
    ...overrides,
  };
}

function journeyEventRow(overrides: D1Row = {}): D1Row {
  return {
    id: "visit-1",
    kind: "pageview",
    eventType: "pageview",
    occurredAt: baseMs + 10_000,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/home",
    hash: "",
    title: "Home",
    hostname: "example.com",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    city: "San Francisco",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    durationMs: 40_000,
    perfTtfbMs: 100,
    perfFcpMs: 250,
    perfLcpMs: 1100,
    perfCls: 0.01,
    perfInpMs: 80,
    ...overrides,
  };
}

function visitorDetailVisitRow(overrides: D1Row = {}): D1Row {
  return {
    sourceType: "visit",
    visitId: "visit-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    status: "closed",
    startedAt: baseMs + 10_000,
    lastActivityAt: baseMs + 50_000,
    endedAt: baseMs + 50_000,
    durationMs: 40_000,
    pathname: "/home",
    hash: "",
    title: "Home",
    hostname: "example.com",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 100,
    perfFcpMs: 250,
    perfLcpMs: 1100,
    perfCls: 0.01,
    perfInpMs: 80,
    ...overrides,
  };
}

function visitorDetailCustomEventRow(overrides: D1Row = {}): D1Row {
  return {
    ...visitorDetailVisitRow(),
    sourceType: "custom",
    eventId: "event-1",
    eventType: "signup",
    occurredAt: baseMs + 20_000,
    ...overrides,
  };
}

describe("edge journey detail D1 queries", () => {
  it("supports aggregation SQL callers without pagination", () => {
    expect(
      buildVisitorAggregationSql({ orderBy: "lastSeenAt DESC" }),
    ).not.toContain("LIMIT ?");
    expect(buildSessionAggregationSql({ orderBy: "startedAt DESC" })).toContain(
      "session_metrics AS",
    );
  });

  it("returns null for a missing visitor detail row and captures target bindings", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryVisitorForDetailFromD1(env, siteId, "visitor-missing"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("visitor_id = ?");
    expect(calls[0].bindings).toEqual([siteId, "visitor-missing", siteId]);
  });

  it("combines visitor, session, and event rows into visitor detail metrics", async () => {
    const secondSessionStart = baseMs + 24 * 60 * 60 * 1000;
    const { env, calls } = createD1Env([
      [
        visitorDetailVisitRow(),
        visitorDetailVisitRow({
          visitId: "visit-2",
          sessionId: "session-2",
          startedAt: secondSessionStart + 10_000,
          endedAt: secondSessionStart + 40_000,
          lastActivityAt: secondSessionStart + 40_000,
          durationMs: 30_000,
          pathname: "/checkout",
        }),
        visitorDetailCustomEventRow({ pathname: "/signup" }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail?.metrics).toMatchObject({
      totalEvents: 1,
      sessions: 2,
      views: 2,
      avgEventsPerSession: 0.5,
      bounceRate: 1,
      avgDurationMs: 35_000,
      p90DurationMs: 40_000,
      daysActive: 2,
      conversionEvents: 1,
      avgTimeBetweenSessionsMs: 24 * 60 * 60 * 1000,
    });
    expect(detail?.visitedPages).toEqual([
      { pathname: "/checkout", views: 1 },
      { pathname: "/home", views: 1 },
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "pageview", count: 2 },
      { eventType: "session start", count: 2 },
      { eventType: "signup", count: 1 },
    ]);
    expect(detail?.performance.ttfb).toMatchObject({
      avg: 100,
      p75: 100,
      samples: 2,
    });
    expect(detail?.events.map((event) => event.id)).toContain(
      "session-start:session-2",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindings).toEqual([siteId, "visitor-1", siteId]);
    expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
    expect(calls[0]?.sql).toContain("event_source AS MATERIALIZED");
  });

  it("returns null visitor detail from an empty shared source", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-missing", "UTC"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindings).toEqual([siteId, "visitor-missing", siteId]);
  });

  it("constrains visitor and session details to an explicit half-open query window", async () => {
    const { env, calls } = createD1Env([[], []]);
    const window = {
      startMs: baseMs,
      endExclusiveMs: baseMs + 60_000,
      nowMs: baseMs + 60_000,
      timeZone: "UTC",
    };

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-outside", "UTC", window),
    ).resolves.toBeNull();
    await expect(
      querySessionDetailFromD1(env, siteId, "session-outside", window),
    ).resolves.toBeNull();

    expect(calls[0]?.sql).toContain("started_at >= ? AND started_at < ?");
    expect(calls[0]?.bindings).toEqual([
      siteId,
      "visitor-outside",
      baseMs,
      baseMs + 60_000,
      siteId,
    ]);
    expect(calls[1]?.bindings).toEqual([
      siteId,
      "session-outside",
      baseMs,
      baseMs + 60_000,
      siteId,
    ]);
  });

  it("uses target-visit and target-event indexes from the shared detail source", async () => {
    const sqlite = createSqliteDetailEnv();
    try {
      sqlite.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-plan",
          siteId,
          "visitor-plan",
          "session-plan",
          "closed",
          baseMs,
          baseMs,
          "/target",
          "example.test",
        );
      sqlite.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-noise",
          siteId,
          "visitor-noise",
          "session-noise",
          "closed",
          baseMs,
          baseMs,
          "/noise",
          "example.test",
        );
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", baseMs);
      sqlite.database
        .prepare(
          `INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(1, "event-plan", siteId, "visit-plan", 1, baseMs, baseMs, 0, 0, 0);
      sqlite.database.exec(`
        WITH RECURSIVE sequence(value) AS (
          VALUES(2)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5001
        )
        INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname
        )
        SELECT
          'visit-noise-' || value,
          '${siteId}',
          'visitor-noise-' || value,
          'session-noise-' || value,
          'closed',
          ${baseMs} + value,
          ${baseMs} + value,
          '/noise',
          'example.test'
        FROM sequence;

        WITH RECURSIVE sequence(value) AS (
          VALUES(2)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5001
        )
        INSERT INTO custom_events (
          event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        )
        SELECT
          value,
          'event-noise-' || value,
          '${siteId}',
          'visit-noise',
          1,
          ${baseMs} + value,
          ${baseMs} + value,
          value,
          0,
          0
        FROM sequence;
        ANALYZE;
      `);

      await expect(
        queryVisitorDetailFromD1(sqlite.env, siteId, "visitor-plan", "UTC"),
      ).resolves.toMatchObject({
        visitor: { visitorId: "visitor-plan" },
        metrics: { totalEvents: 1 },
      });

      expect(sqlite.calls).toHaveLength(1);
      const plan = sqlite.explain(sqlite.calls[0]!);
      expect(
        plan.some((detail) =>
          detail.includes("idx_visits_site_pk_visitor_started_at"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) =>
          detail.includes("idx_custom_events_site_pk_visit_time"),
        ),
      ).toBe(true);
      expect(plan.some((detail) => /SCAN ce(?:\s|$)/.test(detail))).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("uses session-target indexes from the shared session detail source", async () => {
    const sqlite = createSqliteDetailEnv();
    try {
      await expect(
        querySessionDetailFromD1(sqlite.env, siteId, "session-plan"),
      ).resolves.toBeNull();

      expect(sqlite.calls).toHaveLength(1);
      const plan = sqlite.explain(sqlite.calls[0]!);
      expect(
        plan.some((detail) =>
          detail.includes("idx_visits_site_pk_session_started_at"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) =>
          detail.includes("idx_custom_events_site_pk_visit_time"),
        ),
      ).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("keeps pageview metrics when a visitor has no session or custom event", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          sessionId: "",
          startedAt: baseMs,
          durationMs: 0,
        }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail).toMatchObject({
      metrics: {
        totalEvents: 0,
        sessions: 0,
        views: 1,
        avgEventsPerSession: 0,
        bounceRate: 0,
        avgDurationMs: 0,
        p90DurationMs: 0,
        daysActive: 1,
        conversionEvents: 0,
        avgTimeBetweenSessionsMs: 0,
      },
      sessions: [],
      events: [expect.objectContaining({ id: "visit-1", kind: "pageview" })],
      visitedPages: [{ pathname: "/home", views: 1 }],
      eventDistribution: [{ eventType: "pageview", count: 1 }],
      activity: [expect.objectContaining({ count: 1 })],
    });
  });

  it("returns session detail with synthetic start and leave events", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          durationMs: 60_000,
          latitude: "37.7",
          longitude: "-122.4",
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.session).toMatchObject({
      sessionId: "session-1",
      durationMs: 60_000,
    });
    expect(detail?.locationPoints).toEqual([
      {
        latitude: 37.7,
        longitude: -122.4,
        timestampMs: baseMs + 10_000,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        pointCount: 1,
      },
    ]);
    expect(detail?.events.map((event) => event.id)).toEqual([
      "session-leave:session-1",
      "visit-1",
      "session-start:session-1",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "leave", count: 1 },
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("sorts session detail events with id tie-breakers", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          status: "open",
          startedAt: baseMs,
          eventId: undefined,
          eventType: undefined,
          occurredAt: baseMs + 10_000,
          visitId: "visit-1",
        }),
        visitorDetailCustomEventRow({
          eventId: "z-event",
          occurredAt: baseMs + 10_000,
        }),
        visitorDetailCustomEventRow({
          eventId: "a-event",
          occurredAt: baseMs + 10_000,
          pathname: "/a",
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.id)).toEqual([
      "z-event",
      "a-event",
      "visit-1",
      "session-start:session-1",
    ]);
  });

  it("returns null when a session detail lookup has no matching session row", async () => {
    const { env } = createD1Env([[]]);

    await expect(
      querySessionDetailFromD1(env, siteId, "session-missing"),
    ).resolves.toBeNull();
  });

  it("omits leave events for active session detail rows", async () => {
    const { env } = createD1Env([
      [
        visitorDetailVisitRow({
          status: "open",
          endedAt: baseMs + 60_000,
        }),
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.kind)).toEqual([
      "pageview",
      "session_start",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("maps direct detail query rows for sessions, events, and location points", async () => {
    const { env, calls } = createD1Env([
      [sessionRow({ sessionId: "session-2", totalDurationMs: "1500" })],
      [journeyEventRow({ id: "event-2", kind: "custom", eventType: "paid" })],
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
    ]);

    await expect(
      querySessionsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ sessionId: "session-2", durationMs: 1500 }]);
    await expect(
      queryJourneyEventsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ id: "event-2", kind: "custom" }]);
    await expect(
      querySessionLocationPointsFromD1(env, siteId, "session-2"),
    ).resolves.toEqual([
      {
        latitude: 1,
        longitude: 2,
        timestampMs: 3,
        country: "",
        region: "",
        regionCode: "",
        city: "",
        pointCount: 1,
      },
    ]);

    expect(calls[0].sql).toContain("session_id = ?");
    expect(calls[1].sql).toContain("UNION ALL");
    expect(calls[2].bindings).toEqual([siteId, "session-2"]);
  });
});

describe("edge journey list D1 queries", () => {
  it("passes default aggregate arguments through to the visitor list query", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [visitorRow({ visitorId: "visitor-2" })],
    ]);

    await expect(
      queryVisitorAggregate(env, siteId, window, EMPTY_FILTER_DOCUMENT, 6),
    ).resolves.toMatchObject([{ visitorId: "visitor-2" }]);

    expect(calls[0].sql).toContain("ORDER BY lastSeenAt DESC");
    expect(calls[0].bindings.at(-2)).toBe(6);
    expect(calls[0].bindings.at(-1)).toBe(0);
  });

  it("builds visitor list SQL with target, search, sorting, and pagination", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[visitorRow({ visitorId: 123 })]]);

    await expect(
      queryVisitorsFromD1(
        env,
        siteId,
        window,
        filterFixture({ country: "US" }),
        5,
        "123",
        10,
        { key: "views", direction: "asc" },
        "Chrome",
      ),
    ).resolves.toMatchObject([{ visitorId: "123", views: 3 }]);

    expect(calls[0].sql).toContain("matched_visitors");
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].bindings.slice(0, 8)).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "123",
      "us",
    ]);
    expect(calls[0].bindings.at(-2)).toBe(5);
    expect(calls[0].bindings.at(-1)).toBe(10);
  });

  it("builds session list SQL with session target and search filters", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    await expect(
      querySessionsFromD1(
        env,
        siteId,
        window,
        filterFixture({ device: "desktop" }),
        7,
        { type: "session", value: "session-1" },
        2,
        { key: "durationMs", direction: "asc" },
        "pricing",
      ),
    ).resolves.toMatchObject([{ sessionId: "session-1", durationMs: 60_000 }]);

    expect(calls[0].sql).toContain("matched_sessions");
    expect(calls[0].sql).toContain("ORDER BY totalDurationMs ASC");
    expect(calls[0].bindings.slice(0, 8)).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "session-1",
      "desktop",
    ]);
    expect(calls[0].bindings.at(-2)).toBe(7);
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("queries a target journey event list with visit filters and limit", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [journeyEventRow({ id: "event-3", kind: "custom", eventType: "paid" })],
    ]);

    await expect(
      queryJourneyEventsFromD1(
        env,
        siteId,
        window,
        filterFixture({ path: "/pricing" }),
        { type: "session", value: "session-1" },
        20,
      ),
    ).resolves.toMatchObject([{ id: "event-3", kind: "custom" }]);

    expect(calls[0].sql).toContain("INNER JOIN filtered_visits");
    expect(calls[0].sql).toContain("WHERE session_id = ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "session-1",
      "/pricing",
      20,
    ]);
  });
});

describe("edge journey geo D1 queries", () => {
  it("passes geo aggregate calls through to the D1 implementation", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      [],
    ]);

    await expect(
      queryGeoPointAggregate(env, siteId, window, EMPTY_FILTER_DOCUMENT, 5),
    ).resolves.toEqual({
      points: [
        {
          latitude: 1,
          longitude: 2,
          timestampMs: 3,
          country: "",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns point data and country counts when no geo drilldown is active", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        {
          latitude: "42.5",
          longitude: "13.5",
          timestampMs: "100",
          country: "IT",
        },
      ],
      [{ country: "IT", views: "8", sessions: "4", visitors: "3" }],
    ]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 25),
    ).resolves.toEqual({
      points: [
        {
          latitude: 42.5,
          longitude: 13.5,
          timestampMs: 100,
          country: "IT",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "IT", views: 8, sessions: 4, visitors: 3 }],
      regionCounts: [],
      cityCounts: [],
    });
    expect(calls[0].bindings).toEqual([...visitBindings(window), 25]);
    expect(calls[0].sql).not.toContain(
      "WHERE LOWER(TRIM(COALESCE(country, ''))) = ?\n  WHERE",
    );
    expect(calls[0].sql).toContain("WHERE\n    latitude IS NOT NULL");
    expect(calls[1].sql).toContain("GROUP BY country");
  });

  it("defaults missing geo country count fields", async () => {
    const window = queryWindow();
    const { env } = createD1Env([[], [{ country: null }]]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10),
    ).resolves.toMatchObject({
      countryCounts: [{ country: "", views: 0, sessions: 0, visitors: 0 }],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns region counts when drilled into a country", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
        { country: "", regionCode: "", region: "", views: 1 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        env,
        siteId,
        window,
        filterFixture({ geo: "US" }),
        10,
      ),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [
        {
          value: "US::CA::California",
          label: "California",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
      cityCounts: [],
    });
  });

  it("returns city counts when drilled into a region or city scope", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          city: "San Francisco",
          views: "6",
          sessions: "4",
          visitors: "3",
        },
        { country: "US", city: "", views: 100 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        env,
        siteId,
        window,
        filterFixture({ geo: "US::CA::California" }),
        10,
      ),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [],
      cityCounts: [
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          views: 6,
          sessions: 4,
          visitors: 3,
        },
      ],
    });
    expect(calls[1].sql).toContain(
      "GROUP BY country, regionCode, region, city",
    );
  });

  it("defaults missing geo dimension count fields", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ny",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        regionEnv.env,
        siteId,
        window,
        filterFixture({ geo: "US" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "US::NY::NY",
          label: "NY",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "us",
          city: "New York",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        filterFixture({ geo: "US::NY::NY" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "US::New York",
          label: "New York",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
    });
  });

  it("falls back to region names when building geo aggregate values", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "Ontario",
          views: "4",
          sessions: "2",
          visitors: "1",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        regionEnv.env,
        siteId,
        window,
        filterFixture({ geo: "CA" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "CA::ONTARIO::Ontario",
          label: "Ontario",
          views: 4,
          sessions: 2,
          visitors: 1,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "",
          city: "Toronto",
          views: "7",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        filterFixture({ geo: "CA::ON::Ontario" }),
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "CA::Toronto",
          label: "Toronto",
          views: 7,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
  });
});

describe("edge journey handlers", () => {
  it("paginates visitors with a keyset cursor and trims hasMore rows", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        visitorRow({ visitorId: "visitor-1" }),
        visitorRow({ visitorId: "visitor-2" }),
      ],
    ]);

    const response = await handleVisitors(
      env,
      siteId,
      url("/visitors", {
        from: window.startMs,
        to: window.endExclusiveMs,
        pageSize: 1,
        sortBy: "views",
        sortDir: "asc",
        search: "Chrome",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ visitorId: "visitor-1", views: 3, sessions: 2 }],
      meta: {
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextCursor: expect.any(String),
      },
    });
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("rejects invalid and mismatched journey cursors before querying D1", async () => {
    const window = queryWindow();
    const visitors = createD1Env([]);
    const sessions = createD1Env([]);
    const visitorCursor = serializeVisitorListCursor({
      sortKey: "views",
      sortDirection: "asc",
      sortValue: 3,
      lastSeenAt: baseMs,
      visitorId: "visitor-1",
    });
    const sessionCursor = serializeSessionListCursor({
      sortKey: "views",
      sortDirection: "asc",
      sortValue: 2,
      startedAt: baseMs,
      sessionId: "session-1",
    });

    await expect(
      handleVisitors(
        visitors.env,
        siteId,
        url("/visitors", {
          from: window.startMs,
          to: window.endExclusiveMs,
          pageSize: 120,
          cursor: visitorCursor,
          sortBy: "sessions",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handleSessions(
        sessions.env,
        siteId,
        url("/sessions", {
          from: window.startMs,
          to: window.endExclusiveMs,
          pageSize: 120,
          cursor: sessionCursor,
          sortBy: "durationMs",
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(visitors.calls).toHaveLength(0);
    expect(sessions.calls).toHaveLength(0);
  });

  it("returns non-paged sessions with search and default metadata", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
        search: "pricing",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ sessionId: "session-1", visitorId: "visitor-1" }],
      meta: {
        pageSize: 3,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    });
    expect(calls[0].bindings.at(-2)).toBe(3);
    expect(calls[0].bindings.at(-1)).toBe(0);
  });

  it("paginates sessions with a keyset cursor and trims the extra row", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        sessionRow({ sessionId: "session-1" }),
        sessionRow({ sessionId: "session-2" }),
      ],
    ]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.startMs,
        to: window.endExclusiveMs,
        pageSize: 1,
        sortBy: "views",
        sortDir: "asc",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ sessionId: "session-1" }],
      meta: {
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextCursor: expect.any(String),
      },
    });
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("adds a seek predicate after Journey aggregation for a supplied cursor", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [visitorRow({ visitorId: "visitor-2" })],
    ]);
    const cursor = serializeVisitorListCursor({
      sortKey: "views",
      sortDirection: "asc",
      sortValue: 3,
      lastSeenAt: baseMs + 60_000,
      visitorId: "visitor-1",
    });

    await expect(
      handleVisitors(
        env,
        siteId,
        url("/visitors", {
          from: window.startMs,
          to: window.endExclusiveMs,
          pageSize: 1,
          cursor,
          sortBy: "views",
          sortDir: "asc",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });

    expect(calls[0].sql).toContain("vm.views > ?");
    expect(calls[0].sql).toContain("vm.lastSeenAt < ?");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].bindings.at(-6)).toBe(3);
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("serializes Journey cursors only for their matching sort", () => {
    const visitor = serializeVisitorListCursor({
      sortKey: "views",
      sortDirection: "asc",
      sortValue: 3,
      lastSeenAt: baseMs,
      visitorId: "visitor-1",
    });
    const session = serializeSessionListCursor({
      sortKey: "durationMs",
      sortDirection: "desc",
      sortValue: 60_000,
      startedAt: baseMs,
      sessionId: "session-1",
    });

    expect(
      parseVisitorListCursor(visitor, { key: "views", direction: "asc" }),
    ).toMatchObject({ visitorId: "visitor-1", sortValue: 3 });
    expect(
      parseVisitorListCursor(visitor, { key: "sessions", direction: "asc" }),
    ).toBeNull();
    expect(
      parseSessionListCursor(session, {
        key: "durationMs",
        direction: "desc",
      }),
    ).toMatchObject({ sessionId: "session-1", sortValue: 60_000 });
    expect(
      parseSessionListCursor(session, { key: "durationMs", direction: "asc" }),
    ).toBeNull();
  });

  it("rejects invalid list windows before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitors = await handleVisitors(
      env,
      siteId,
      new URL("https://edge.test/visitors?from=20&to=10"),
    );
    const sessions = await handleSessions(
      env,
      siteId,
      new URL("https://edge.test/sessions?from=20&to=10"),
    );

    expect(visitors.status).toBe(400);
    expect(sessions.status).toBe(400);
    await expect(visitors.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(sessions.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(calls).toEqual([]);
  });

  it("validates missing detail ids before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      new URL("https://edge.test/visitor-detail"),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      new URL("https://edge.test/session-detail"),
    );

    expect(visitor.status).toBe(400);
    expect(session.status).toBe(400);
    await expect(visitor.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing visitorId" },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing sessionId" },
    });
    expect(calls).toEqual([]);
  });

  it("returns visitor and session detail handler payloads", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [visitorDetailVisitRow()],
      [visitorDetailVisitRow({ latitude: 1, longitude: 2, startedAt: 3 })],
    ]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      url("/visitor-detail", {
        visitorId: "visitor-1",
        timeZone: "Bad/Zone",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      url("/session-detail", {
        sessionId: "session-1",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    await expect(visitor.json()).resolves.toMatchObject({
      ok: true,
      data: {
        visitor: { visitorId: "visitor-1" },
        metrics: { sessions: 1 },
      },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: true,
      data: {
        session: { sessionId: "session-1" },
        locationPoints: [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      },
    });
  });
});
