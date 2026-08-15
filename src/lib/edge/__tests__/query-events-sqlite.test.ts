import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { QueryWindow } from "@/lib/edge/query/core";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/query/events-context";
import { queryEventFieldsFromD1 } from "@/lib/edge/query/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import {
  type EventRecordCursor,
  queryEventRecordPageFromD1,
  queryEventRecordsFromD1,
} from "@/lib/edge/query/events-records";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/query/events-trend";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/query/journey-list-queries";
import type { Env } from "@/lib/edge/types";

type Binding = string | number | null;
type D1Row = Record<string, unknown>;

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Binding[],
  ) {}

  async all<T extends D1Row>(): Promise<{ results: T[] }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...this.bindings)
        .map((row) => ({ ...row }) as T),
    };
  }
}

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: Array<{ sql: string; bindings: Binding[] }> = [];

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) => {
        this.calls.push({ sql, bindings });
        return new SqliteStatement(this.database, sql, bindings);
      },
    };
  }

  close(): void {
    this.database.close();
  }
}

const siteId = "site-event-detail";
const eventName = "outbound_click";
const eventTime = Date.UTC(2026, 7, 14, 10);
const window: QueryWindow = {
  fromMs: eventTime - 60 * 60 * 1000,
  toMs: eventTime + 60 * 60 * 1000,
  nowMs: eventTime + 60 * 60 * 1000,
  timeZone: "UTC",
};

function createSqliteEventEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY, site_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'closed', started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, finalized_at INTEGER,
      duration_ms INTEGER, duration_source TEXT, exit_reason TEXT,
      pathname TEXT NOT NULL DEFAULT '', query_string TEXT NOT NULL DEFAULT '',
      hash_fragment TEXT NOT NULL DEFAULT '', hostname TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', referrer_url TEXT NOT NULL DEFAULT '',
      referrer_host TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '',
      utm_term TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
      is_eu INTEGER NOT NULL DEFAULT 0, country TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '', region_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '', continent TEXT NOT NULL DEFAULT '', latitude REAL,
      longitude REAL, postal_code TEXT NOT NULL DEFAULT '', metro_code TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '', as_organization TEXT NOT NULL DEFAULT '',
      ua_raw TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '',
      browser_version TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '', device_type TEXT NOT NULL DEFAULT '',
      screen_width INTEGER, screen_height INTEGER, language TEXT NOT NULL DEFAULT '',
      perf_ttfb_ms REAL, perf_fcp_ms REAL, perf_lcp_ms REAL, perf_cls REAL,
      perf_inp_ms REAL, ae_synced_at INTEGER
    );
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(site_id, name)
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY, event_id TEXT NOT NULL, site_id TEXT NOT NULL,
      visit_id TEXT NOT NULL, event_name_id INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL, sequence INTEGER NOT NULL, node_count INTEGER NOT NULL,
      value_count INTEGER NOT NULL, ae_synced_at INTEGER
    );
    CREATE TABLE custom_event_json_paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE custom_event_json_values (
      event_pk INTEGER NOT NULL, path_id INTEGER NOT NULL, value_type INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL, string_value TEXT, number_value REAL, boolean_value INTEGER
    );
    CREATE INDEX idx_custom_events_site_name_time
      ON custom_events(site_id, event_name_id, occurred_at, event_pk);
    CREATE INDEX idx_visits_site_session_started_at
      ON visits(site_id, session_id, started_at, visit_id);
  `);
  d1.database
    .prepare(
      `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, started_at, pathname, hostname,
      title, referrer_url, referrer_host, country, region, city, continent, timezone,
      as_organization, browser, browser_version, os, os_version, device_type,
      screen_width, screen_height, language
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-1",
      siteId,
      "visitor-1",
      "session-1",
      eventTime - 1,
      "/posts/minecraft-meteor-guide",
      "example.com",
      "Meteor guide",
      "https://www.google.com/",
      "www.google.com",
      "CN",
      "Zhejiang",
      "Hangzhou",
      "Asia",
      "Asia/Shanghai",
      "Example Networks",
      "Edge",
      "140",
      "Windows",
      "11",
      "desktop",
      1920,
      1080,
      "zh-CN",
    );
  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(1, siteId, eventName);
  d1.database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-entry",
      siteId,
      "visitor-1",
      "session-1",
      eventTime - 2,
      "/entry",
    );
  d1.database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-exit",
      siteId,
      "visitor-1",
      "session-1",
      eventTime + 1,
      "/exit",
    );
  d1.database
    .prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      1,
      "event-1",
      siteId,
      "visit-1",
      1,
      eventTime,
      eventTime,
      1,
      1,
      1,
      null,
    );
  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(99, siteId, "purchase");
  d1.database
    .prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      99,
      "event-other-name",
      siteId,
      "visit-1",
      99,
      eventTime,
      eventTime,
      2,
      1,
      1,
      null,
    );
  d1.database
    .prepare("INSERT INTO custom_event_json_paths VALUES (?, ?)")
    .run(1, "/href");
  d1.database
    .prepare(
      "INSERT INTO custom_event_json_values VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(1, 1, 1, eventTime, "https://example.test/next", null, null);
  return {
    env: {
      DB: d1 as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    d1,
  } as { env: Env; d1: SqliteD1Database };
}

describe("event detail D1 SQL", () => {
  it("returns the same event context and payload data as the event records query", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const [records, overview, trend, fields, cards] = await Promise.all([
        queryEventRecordsFromD1(
          env,
          siteId,
          window,
          {},
          {
            limit: 25,
            offset: 0,
            sort: { key: "occurredAt", direction: "desc" },
            eventName,
          },
        ),
        queryEventTypeOverviewFromD1(env, siteId, window, {}, eventName),
        queryEventTypeTrendFromD1(env, siteId, window, "hour", {}, eventName),
        queryEventFieldsFromD1(env, siteId, window, {}, eventName, 100),
        queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          {},
          100,
          eventName,
        ),
      ]);

      expect(records).toHaveLength(1);
      expect(overview.summary.events).toBe(1);
      expect(trend.data.some((point) => point.events === 1)).toBe(true);
      expect(fields).toMatchObject([{ path: "/href", events: 1 }]);
      expect(cards.page.path).toMatchObject([
        { value: "/posts/minecraft-meteor-guide", views: 1 },
      ]);
      expect(cards.source.domain).toMatchObject([
        { value: "www.google.com", views: 1 },
      ]);
      expect(cards.client.browser).toMatchObject([{ value: "Edge", views: 1 }]);
      expect(cards.geo.country).toMatchObject([{ value: "CN", views: 1 }]);
      expect(cards.page.entry).toMatchObject([{ value: "/entry", views: 1 }]);
      expect(cards.page.exit).toMatchObject([{ value: "/exit", views: 1 }]);
      const cardQueries = d1.calls.filter(({ sql }) =>
        sql.includes("\ncard_rows AS"),
      );
      expect(cardQueries).toHaveLength(1);
      const cardQuery = cardQueries[0];
      expect((cardQuery.sql.match(/card_group_\d+ AS \(/g) ?? []).length).toBe(
        4,
      );
      expect(
        (cardQuery.sql.match(/SELECT \* FROM card_group_\d+/g) ?? []).length,
      ).toBe(4);
      const cardPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cardQuery.sql}`)
        .all(...cardQuery.bindings) as Array<{ detail: string }>;
      const cardPlanDetails = cardPlan.map((row) => row.detail).join("\n");
      expect(cardPlanDetails).toContain("MATERIALIZE filtered_events");
      expect(
        (cardPlanDetails.match(/MATERIALIZE filtered_events/g) ?? []).length,
      ).toBe(1);
      const overviewQuery = d1.calls.find(({ sql }) =>
        sql.includes("overview_card_rows AS"),
      );
      expect(overviewQuery).toBeDefined();
      expect((overviewQuery?.sql.match(/UNION ALL/g) ?? []).length).toBe(4);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${overviewQuery?.sql ?? "SELECT 1"}`)
        .all(...(overviewQuery?.bindings ?? [])) as Array<{ detail: string }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(planDetails).toContain("MATERIALIZE filtered_events");
      expect(planDetails).toContain("idx_custom_events_site_name_time");

      const entryExitPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cardQuery.sql}`)
        .all(...cardQuery.bindings) as Array<{ detail: string }>;
      expect(entryExitPlan.map((row) => row.detail).join("\n")).toContain(
        "idx_visits_site_session_started_at",
      );
    } finally {
      d1.close();
    }
  });

  it("matches offset ordering with keyset pages for every event-record sort", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      d1.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, started_at, pathname
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-2",
          siteId,
          "visitor-2",
          "session-2",
          eventTime,
          "/pricing",
        );
      d1.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
        )
        .run(2, siteId, "Purchase");
      for (const [eventPk, eventId, visitId, eventNameId, occurredAt] of [
        [2, "event-2", "visit-1", 1, eventTime + 1],
        [3, "event-3", "visit-2", 2, eventTime + 1],
        [4, "event-4", "visit-2", 2, eventTime],
      ]) {
        d1.database
          .prepare(
            "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            eventPk,
            eventId,
            siteId,
            visitId,
            eventNameId,
            occurredAt,
            occurredAt,
            eventPk,
            1,
            1,
            null,
          );
      }

      for (const sort of [
        { key: "occurredAt", direction: "asc" },
        { key: "occurredAt", direction: "desc" },
        { key: "eventName", direction: "asc" },
        { key: "eventName", direction: "desc" },
        { key: "pathname", direction: "asc" },
        { key: "pathname", direction: "desc" },
      ] as const) {
        const expected = await queryEventRecordsFromD1(
          env,
          siteId,
          window,
          {},
          {
            limit: 20,
            offset: 0,
            sort,
          },
        );
        const received = [];
        let cursor = null;
        do {
          const page = await queryEventRecordPageFromD1(
            env,
            siteId,
            window,
            {},
            {
              pageSize: 2,
              sort,
              cursor,
            },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);

        expect(received.map((row) => row.eventId)).toEqual(
          expected.map((row) => row.eventId),
        );
      }

      const cursorQuery = d1.calls.at(-1);
      expect(cursorQuery?.sql).not.toContain("OFFSET");
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cursorQuery?.sql ?? "SELECT 1"}`)
        .all(...(cursorQuery?.bindings ?? []));
      expect(plan.length).toBeGreaterThan(0);
    } finally {
      d1.close();
    }
  });

  it("matches Journey offset ordering with keyset pages for every list sort", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      for (const [visitId, visitorId, sessionId, startedAt] of [
        ["visit-2", "visitor-2", "session-2", eventTime],
        ["visit-3", "visitor-2", "session-2", eventTime + 2],
        ["visit-4", "visitor-3", "session-3", eventTime + 2],
      ] as const) {
        d1.database
          .prepare(
            `INSERT INTO visits (
              visit_id, site_id, visitor_id, session_id, started_at, pathname
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(visitId, siteId, visitorId, sessionId, startedAt, "/pricing");
      }

      for (const sort of [
        { key: "firstSeenAt", direction: "asc" },
        { key: "firstSeenAt", direction: "desc" },
        { key: "lastSeenAt", direction: "asc" },
        { key: "lastSeenAt", direction: "desc" },
        { key: "sessions", direction: "asc" },
        { key: "sessions", direction: "desc" },
        { key: "views", direction: "asc" },
        { key: "views", direction: "desc" },
      ] as const) {
        const expected = await queryVisitorsFromD1(
          env,
          siteId,
          window,
          {},
          20,
          undefined,
          0,
          sort,
        );
        const received = [];
        let cursor = null;
        do {
          const page = await queryVisitorListPageFromD1(
            env,
            siteId,
            window,
            {},
            { pageSize: 2, sort, cursor },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);
        expect(received.map((row) => row.visitorId)).toEqual(
          expected.map((row) => row.visitorId),
        );
      }

      for (const sort of [
        { key: "startedAt", direction: "asc" },
        { key: "startedAt", direction: "desc" },
        { key: "durationMs", direction: "asc" },
        { key: "durationMs", direction: "desc" },
        { key: "views", direction: "asc" },
        { key: "views", direction: "desc" },
      ] as const) {
        const expected = await querySessionsFromD1(
          env,
          siteId,
          window,
          {},
          20,
          undefined,
          0,
          sort,
        );
        const received = [];
        let cursor = null;
        do {
          const page = await querySessionListPageFromD1(
            env,
            siteId,
            window,
            {},
            { pageSize: 2, sort, cursor },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);
        expect(received.map((row) => row.sessionId)).toEqual(
          expected.map((row) => row.sessionId),
        );
      }

      const cursorQuery = d1.calls.at(-1);
      expect(cursorQuery?.sql).not.toContain("OFFSET");
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cursorQuery?.sql ?? "SELECT 1"}`)
        .all(...(cursorQuery?.bindings ?? []));
      expect(plan.length).toBeGreaterThan(0);
    } finally {
      d1.close();
    }
  });
});
