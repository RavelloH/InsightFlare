import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  EMPTY_FILTER_DOCUMENT,
  normalizeFilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventFieldsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  type EventRecordCursor,
  queryEventRecordPageFromD1,
  queryEventRecordsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { queryEventSummaryMetricsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/internal/funnels";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";

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
  startMs: eventTime - 60 * 60 * 1000,
  endExclusiveMs: eventTime + 60 * 60 * 1000,
  nowMs: eventTime + 60 * 60 * 1000,
  timeZone: "UTC",
};

function createSqliteEventEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE site_identities (
      site_pk INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL UNIQUE
    );
    INSERT INTO site_identities (site_pk, site_id)
      VALUES (1, '${siteId}');

    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY, site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
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
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      name TEXT NOT NULL,
      UNIQUE(site_id, name)
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY, event_id TEXT NOT NULL, site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      visit_id TEXT NOT NULL, event_name_id INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL, sequence INTEGER NOT NULL, node_count INTEGER NOT NULL,
      value_count INTEGER NOT NULL, ae_synced_at INTEGER
    );
    CREATE TABLE custom_event_json_paths (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED
    );
    CREATE TABLE custom_event_json_values (
      event_pk INTEGER NOT NULL, path_id INTEGER NOT NULL, value_type INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL, string_value TEXT, number_value REAL, boolean_value INTEGER,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED
    );
    CREATE INDEX idx_custom_events_site_pk_name_time
      ON custom_events(site_pk, event_name_id, occurred_at, event_pk);
    CREATE INDEX idx_custom_events_site_pk_time
      ON custom_events(site_pk, occurred_at, event_pk);
    CREATE INDEX idx_visits_site_pk_session_started_at
      ON visits(site_pk, session_id, started_at, visit_id);
    CREATE INDEX idx_visits_site_pk_started_at
      ON visits(site_pk, started_at);
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
  it("runs event-record pages through the canonical scoped dataset", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("event-records", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: EMPTY_FILTER_DOCUMENT,
      scopePreference: "auto",
    } as QueryInput & { time: QueryTime });

    try {
      const page = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        prepared.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
        },
      );

      expect(page.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);
      expect(d1.calls.at(-1)?.sql).toContain("FROM scope_final_events es");
    } finally {
      d1.close();
    }
  });

  it("uses the event-name index for the all-events trend source", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        5,
        eventName,
      );
      const query = d1.calls[0];
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? "SELECT 1"}`)
        .all(...(query?.bindings ?? [])) as Array<{ detail: string }>;
      expect(query?.sql).toContain("target_event_name AS");
      expect(query?.sql).not.toContain("TRIM(COALESCE(es.event_name");
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "idx_custom_events_site_pk_name_time",
      );
    } finally {
      d1.close();
    }
  });

  it("adds a scoped visit source for session-boundary event filters", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const summary = await queryEventSummaryMetricsFromD1(
        env,
        siteId,
        window,
        filterFixture({ entry: "/entry" }),
      );
      expect(summary.events).toBe(2);
      const query = d1.calls.at(-1);
      expect(query?.sql).toContain("visit_source AS");
      expect(query?.sql).toContain("ROW_NUMBER() OVER");
      expect(query?.bindings.slice(0, 6)).toEqual([
        siteId,
        window.startMs,
        window.endExclusiveMs,
        siteId,
        window.startMs,
        window.endExclusiveMs,
      ]);
    } finally {
      d1.close();
    }
  });

  it("returns the same event context and payload data as the event records query", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const [records, overview, trend, fields, cards] = await Promise.all([
        queryEventRecordsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, {
          limit: 25,
          offset: 0,
          sort: { key: "occurredAt", direction: "desc" },
          eventName,
        }),
        queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          eventName,
        ),
        queryEventTypeTrendFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          eventName,
        ),
        queryEventFieldsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          eventName,
          100,
        ),
        queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          100,
          eventName,
        ),
      ]);

      expect(records).toHaveLength(1);
      expect(overview.summary.events).toBe(1);
      expect(overview.summary.shareOfAllEvents).toBe(0.5);
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
      expect(
        d1.calls.filter(({ sql }) => sql.includes("scoped_summary AS")),
      ).toHaveLength(1);
      expect((overviewQuery?.sql.match(/UNION ALL/g) ?? []).length).toBe(4);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${overviewQuery?.sql ?? "SELECT 1"}`)
        .all(...(overviewQuery?.bindings ?? [])) as Array<{ detail: string }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(planDetails).toContain("MATERIALIZE filtered_events");
      expect(planDetails).toContain("idx_custom_events_site_pk_name_time");
      expect(planDetails).toContain("idx_custom_events_site_pk_time");
      expect(planDetails.match(/SEARCH v /g) ?? []).toHaveLength(1);
      expect(overviewQuery?.sql).not.toContain("scoped_event_source AS");

      const entryExitPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cardQuery.sql}`)
        .all(...cardQuery.bindings) as Array<{ detail: string }>;
      expect(entryExitPlan.map((row) => row.detail).join("\n")).toContain(
        "idx_visits_site_pk_session_started_at",
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

      const legacyOffsetRows = await queryEventRecordsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        {
          limit: 2,
          offset: 1,
          sort: { key: "occurredAt", direction: "desc" },
        },
      );
      expect(legacyOffsetRows).toHaveLength(2);

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
          EMPTY_FILTER_DOCUMENT,
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
            EMPTY_FILTER_DOCUMENT,
            {
              limit: 2,
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
      expect(cursorQuery?.sql).not.toContain("SELECT *");
      expect(cursorQuery?.sql).not.toContain("filtered_events AS");
      expect(cursorQuery?.sql).toContain("FROM event_source es");
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cursorQuery?.sql ?? "SELECT 1"}`)
        .all(...(cursorQuery?.bindings ?? []));
      expect(plan.length).toBeGreaterThan(0);
    } finally {
      d1.close();
    }
  });

  it("uses the event-name index for filtered event records", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const records = await queryEventRecordsFromD1(
        env,
        siteId,
        window,
        filterFixture({
          query: "",
          sourceLink: "https://www.google.com/",
          clientLanguage: "zh-CN",
          clientScreenSize: "1920x1080",
          geoContinent: "Asia",
          geoTimezone: "Asia/Shanghai",
          geoOrganization: "Example Networks",
        }),
        {
          limit: 25,
          offset: 0,
          sort: { key: "occurredAt", direction: "desc" },
          eventName,
        },
      );

      expect(records.map((record) => record.eventId)).toEqual(["event-1"]);
      const query = d1.calls.at(-1);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? "SELECT 1"}`)
        .all(...(query?.bindings ?? [])) as Array<{ detail: string }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(query?.sql).toContain("target_event_name AS");
      expect(query?.sql).not.toContain("TRIM(COALESCE(es.event_name");
      expect(planDetails).toContain("idx_custom_events_site_pk_name_time");
      expect(query?.sql).toContain("v.query_string");
      expect(query?.sql).toContain("v.referrer_url");
      expect(query?.sql).toContain("v.screen_width");
      expect(query?.sql).toContain("v.as_organization");
    } finally {
      d1.close();
    }
  });

  it("uses the event-name index for funnel event steps", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        [{ type: "event", value: eventName }],
      );

      expect(analysis.summary.totalSessions).toBe(1);
      const query = d1.calls.find((call) =>
        call.sql.includes("target_event_names AS"),
      );
      expect(query?.sql).not.toContain("es.event_name IN");
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? "SELECT 1"}`)
        .all(...(query?.bindings ?? [])) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "idx_custom_events_site_pk_name_time",
      );
    } finally {
      d1.close();
    }
  });

  it("applies page filters to the session scope without removing funnel steps", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        [
          { type: "pageview", value: "/entry" },
          { type: "pageview", value: "/posts/minecraft-meteor-guide" },
          { type: "event", value: eventName },
        ],
      );

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1, 1]);
      expect(analysis.summary).toMatchObject({
        totalSessions: 1,
        convertedSessions: 1,
      });
      expect(
        d1.calls.some((call) => call.sql.includes("matched_sessions")),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("feeds funnel progression from the final scoped relations", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("funnel-analysis", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "event",
    } as QueryInput & { time: QueryTime });

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        prepared.filters!,
        [
          { type: "pageview", value: "/posts/minecraft-meteor-guide" },
          { type: "event", value: eventName },
        ],
      );

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1]);
      expect(analysis.summary).toMatchObject({
        totalSessions: 1,
        convertedSessions: 1,
      });
      expect(
        d1.calls.some((call) => call.sql.includes("FROM scope_final_visits")),
      ).toBe(true);
      expect(
        d1.calls.some((call) => call.sql.includes("FROM scope_final_events")),
      ).toBe(true);
      expect(
        d1.calls.every((call) => !call.sql.includes("matched_sessions AS")),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("uses event filters to select funnel sessions before loading page steps", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const filters = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "event.name" },
          operator: "eq",
          value: eventName,
        },
      },
      analyticsFilterRegistry,
    );

    try {
      const analysis = await queryFunnelAnalysis(env, siteId, window, filters, [
        { type: "pageview", value: "/entry" },
        { type: "event", value: eventName },
      ]);

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1]);
      expect(
        d1.calls.every((call) => call.sql.includes("filter_event_source")),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("queries only requested context cards without building session edges", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const cards = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
        eventName,
        ["path"],
      );

      expect(cards.page.path).toMatchObject([
        { value: "/posts/minecraft-meteor-guide", views: 1 },
      ]);
      expect(cards.page.entry).toEqual([]);
      expect(cards.source.domain).toEqual([]);
      const query = d1.calls.at(-1);
      expect(query?.sql).not.toContain("session_visit_edges");
      expect(query?.sql).toContain("'path' AS cardType");
      expect(query?.sql).not.toContain("'browser' AS cardType");
    } finally {
      d1.close();
    }
  });

  it("derives scoped event entry and exit from the final visit relation", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("event-context", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "event",
    } as QueryInput & { time: QueryTime });

    try {
      const cards = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        prepared.filters!,
        100,
        eventName,
        ["entry", "exit"],
      );

      expect(cards.page.entry).toMatchObject([
        { value: "/posts/minecraft-meteor-guide" },
      ]);
      expect(cards.page.exit).toMatchObject([
        { value: "/posts/minecraft-meteor-guide" },
      ]);
      expect(d1.calls.at(-1)?.sql).toContain("INNER JOIN scope_final_visits v");
    } finally {
      d1.close();
    }
  });

  it("keeps all four final relations aligned for Event and Visitor scopes", () => {
    const { env, d1 } = createSqliteEventEnv();
    const visitorPrepared = prepareScopedQuery("overview", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "visitor",
    } as QueryInput & { time: QueryTime });

    try {
      const visitorDataset = compileScopedDatasetSql({
        filters: visitorPrepared.filters!,
        plan: visitorPrepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const visitorCounts = d1.database
        .prepare(
          `
          WITH ${visitorDataset.ctes}
          SELECT
            (SELECT count(*) FROM ${visitorDataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${visitorDataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${visitorDataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${visitorDataset.visitorRelation}) AS visitors
        `,
        )
        .get(...visitorDataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(visitorCounts).toEqual({
        visits: 3,
        events: 2,
        sessions: 1,
        visitors: 1,
      });

      const eventPrepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: {
          range: {
            startMs: window.startMs,
            endExclusiveMs: window.endExclusiveMs,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: window.nowMs,
        },
        filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        scopePreference: "event",
      } as QueryInput & { time: QueryTime });
      const eventDataset = compileScopedDatasetSql({
        filters: eventPrepared.filters!,
        plan: eventPrepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const eventCounts = d1.database
        .prepare(
          `
          WITH ${eventDataset.ctes}
          SELECT
            (SELECT count(*) FROM ${eventDataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${eventDataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${eventDataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${eventDataset.visitorRelation}) AS visitors
        `,
        )
        .get(...eventDataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(eventCounts).toEqual({
        visits: 1,
        events: 2,
        sessions: 1,
        visitors: 1,
      });
    } finally {
      d1.close();
    }
  });

  it("includes an entity represented only by an in-window custom event", () => {
    const { env, d1 } = createSqliteEventEnv();
    const eventOnlyVisitStart = window.startMs - 2 * 60 * 60 * 1000;
    d1.database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, started_at, pathname
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "visit-event-only",
        siteId,
        "visitor-event-only",
        "session-event-only",
        eventOnlyVisitStart,
        "/outside-window",
      );
    d1.database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
      )
      .run(100, siteId, "event_only_type");
    d1.database
      .prepare(
        "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        2,
        "event-only",
        siteId,
        "visit-event-only",
        100,
        eventTime,
        eventTime,
        1,
        1,
        1,
        null,
      );

    try {
      const prepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: {
          range: {
            startMs: window.startMs,
            endExclusiveMs: window.endExclusiveMs,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: window.nowMs,
        },
        filters: normalizeFilterDocument(
          {
            version: 1,
            root: {
              kind: "condition",
              target: { kind: "field", field: "event.name" },
              operator: "eq",
              value: "event_only_type",
            },
          },
          analyticsFilterRegistry,
        ),
        scopePreference: "visitor",
      } as QueryInput & { time: QueryTime });
      const dataset = compileScopedDatasetSql({
        filters: prepared.filters!,
        plan: prepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const counts = d1.database
        .prepare(
          `
          WITH ${dataset.ctes}
          SELECT
            (SELECT count(*) FROM ${dataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${dataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${dataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${dataset.visitorRelation}) AS visitors
        `,
        )
        .get(...dataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(counts).toEqual({
        visits: 0,
        events: 1,
        sessions: 1,
        visitors: 1,
      });
    } finally {
      d1.close();
    }
  });

  it("skips unused event overview breakdowns without changing summary metrics", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const overview = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
        { includeBreakdowns: false },
      );

      expect(overview.summary).toMatchObject({
        events: 1,
        eventTypes: 1,
        shareOfAllEvents: 0.5,
      });
      expect(overview.breakdowns).toEqual({
        pages: [],
        countries: [],
        devices: [],
        browsers: [],
      });
      const query = d1.calls.at(-1);
      expect(query?.sql).not.toContain("'page' AS cardType");
      expect(query?.sql).not.toContain("'country' AS cardType");
    } finally {
      d1.close();
    }
  });

  it("keeps the scoped event source when overview filters affect share metrics", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        eventName,
        { includeBreakdowns: false },
      );

      const query = d1.calls.at(-1);
      expect(query?.sql).toContain("scoped_event_source AS");
      expect(query?.sql).toContain("TRIM(COALESCE(es.pathname, '')) = ?");
    } finally {
      d1.close();
    }
  });

  it("keeps complete journey aggregates after a visit filter matches", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      d1.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, started_at, pathname
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-other-session",
          siteId,
          "visitor-1",
          "session-2",
          eventTime + 2,
          "/other",
        );

      const filter = filterFixture({ path: "/posts/minecraft-meteor-guide" });
      const sessions = await querySessionsFromD1(
        env,
        siteId,
        window,
        filter,
        10,
      );
      const visitors = await queryVisitorsFromD1(
        env,
        siteId,
        window,
        filter,
        10,
      );
      const sessionPage = await querySessionListPageFromD1(
        env,
        siteId,
        window,
        filter,
        {
          limit: 10,
          sort: { key: "startedAt", direction: "asc" },
        },
      );
      const visitorPage = await queryVisitorListPageFromD1(
        env,
        siteId,
        window,
        filter,
        {
          limit: 10,
          sort: { key: "firstSeenAt", direction: "asc" },
        },
      );

      expect(sessions).toMatchObject([
        {
          sessionId: "session-1",
          views: 3,
          entryPath: "/entry",
          exitPath: "/exit",
        },
      ]);
      expect(visitors).toMatchObject([
        {
          visitorId: "visitor-1",
          views: 4,
          sessions: 2,
          firstSeenAt: eventTime - 2,
          lastSeenAt: eventTime + 2,
        },
      ]);
      expect(sessionPage.rows).toEqual(sessions);
      expect(visitorPage.rows).toEqual(visitors);
    } finally {
      d1.close();
    }
  });

  it("applies generic event filters to journey entities", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const filters = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: "event.name" },
              operator: "eq",
              value: eventName,
            },
            {
              kind: "condition",
              target: { kind: "event-payload", path: "/href" },
              operator: "contains",
              value: "example.test",
            },
          ],
        },
      },
      analyticsFilterRegistry,
    );

    try {
      const [sessions, visitors] = await Promise.all([
        querySessionsFromD1(env, siteId, window, filters, 10),
        queryVisitorsFromD1(env, siteId, window, filters, 10),
      ]);

      expect(sessions).toMatchObject([{ sessionId: "session-1", views: 3 }]);
      expect(visitors).toMatchObject([
        { visitorId: "visitor-1", views: 3, sessions: 1 },
      ]);
      expect(d1.calls.every(({ sql }) => sql.includes("EXISTS ("))).toBe(true);
      expect(
        d1.calls.every(({ sql }) =>
          sql.includes("event_filter_source.event_name"),
        ),
      ).toBe(true);
      expect(
        d1.calls.every(({ sql }) =>
          sql.includes("event_filter_source.event_pk"),
        ),
      ).toBe(true);
      expect(
        d1.calls.every(({ sql }) => !sql.includes("visit_source.event_name")),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("keeps the original journey aggregation path without filters", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await querySessionsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10);
      expect(d1.calls.at(-1)?.sql).not.toContain("matched_sessions AS");

      await queryVisitorsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10);
      expect(d1.calls.at(-1)?.sql).not.toContain("matched_visitors AS");
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
          EMPTY_FILTER_DOCUMENT,
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
            EMPTY_FILTER_DOCUMENT,
            { limit: 2, sort, cursor },
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
          EMPTY_FILTER_DOCUMENT,
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
            EMPTY_FILTER_DOCUMENT,
            { limit: 2, sort, cursor },
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
