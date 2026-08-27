import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  handleEventFieldValuesContract as handleEventTypeFieldValues,
  handleEventRecordDetailContract as handleEventRecordDetail,
  handleEventRecordsContract as handleEventsRecords,
  handleEventsSummaryContract as handleEventsSummary,
  handleEventsTrendContract as handleEventsTrend,
  handleEventTypeContextContract as handleEventTypeContext,
  handleEventTypeDetailContract as handleEventTypeDetail,
  handleEventTypeFieldsContract as handleEventTypeFields,
  handleEventTypesContract as handleEventTypes,
} from "@/lib/edge/analytics/composition/protocol/events-contract-adapter";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type {
  EventRecordRow,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
  queryPageTabsFromD1,
  queryReferrersFromD1,
  querySessionBoundaryDimensionFromD1,
  querySessionPathDimensionFromD1,
  queryVisitDimensionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  parseEventRecordCursor,
  queryEventRecordDetailFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { readCustomEventDetail } from "@/lib/edge/custom-event-read";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";
import { installVisitSiteIdentityFixture } from "./site-identity-fixture";

vi.mock("@/lib/edge/custom-event-read", () => ({
  readCustomEventDetail: vi.fn(),
}));

type D1Row = Record<string, unknown> | EventRecordRow;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const readCustomEventDetailMock = vi.mocked(readCustomEventDetail);

const siteId = "site-lowlevel";
const baseMs = Date.UTC(2026, 0, 4, 8);
const window: QueryWindow = {
  startMs: baseMs,
  endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};

function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
  prepare: ReturnType<typeof vi.fn>;
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
    prepare,
  };
}

function visitBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.startMs, targetWindow.endExclusiveMs];
}

function eventBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.startMs, targetWindow.endExclusiveMs];
}

function url(
  path: string,
  params: Record<string, string | number | boolean>,
): URL {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

function eventRecord(overrides: Partial<EventRecordRow> = {}): EventRecordRow {
  return {
    eventId: "evt-1",
    eventName: "Signup",
    occurredAt: baseMs + 100,
    receivedAt: baseMs + 200,
    sequence: 1,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/signup",
    title: "Signup",
    hostname: "example.com",
    referrerHost: "news.example",
    country: "US",
    region: "US::CA::California",
    city: "US::CA::California::San Francisco",
    browser: "Chrome",
    browserVersion: "124",
    os: "Windows",
    osVersion: "11",
    deviceType: "desktop",
    nodeCount: 3,
    valueCount: 2,
    ...overrides,
  };
}

describe("edge query dimensions low-level coverage", () => {
  it("normalizes sparse visit dimension and referrer aggregate rows", async () => {
    const { env, calls } = createD1Env([
      [{ value: null, views: undefined, sessions: null, visitors: undefined }],
      [
        {
          referrer: null,
          views: undefined,
          sessions: null,
          visitors: undefined,
        },
      ],
    ]);

    await expect(
      queryVisitDimensionFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        "country",
      ),
    ).resolves.toEqual([{ value: "", views: 0, sessions: 0, visitors: 0 }]);
    await expect(
      queryReferrersFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        3,
        false,
      ),
    ).resolves.toEqual([{ referrer: "", views: 0, sessions: 0, visitors: 0 }]);

    expect(calls[0].bindings).toEqual([...visitBindings(), 2]);
    expect(calls[1].sql).toContain("COALESCE(referrer_host, '') AS referrer");
    expect(calls[1].bindings).toEqual([...visitBindings(), 3]);
  });

  it("queries session path dimensions with set-based boundary ranking and maps fallback row values", async () => {
    const filters: FilterDocument = filterFixture({ browser: "Chrome" });
    const { env, calls } = createD1Env([
      [{ value: null, views: "4", sessions: undefined, visitors: null }],
      [{ value: "/entry", views: 2, sessions: "1", visitors: "1" }],
    ]);

    await expect(
      querySessionPathDimensionFromD1(env, siteId, window, filters, 5, "exit"),
    ).resolves.toEqual([{ value: "", views: 4, sessions: 0, visitors: 0 }]);
    await expect(
      querySessionBoundaryDimensionFromD1(
        env,
        siteId,
        window,
        filters,
        3,
        "entry",
      ),
    ).resolves.toEqual([
      { value: "/entry", views: 2, sessions: 1, visitors: 1 },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("ranked_session_visits AS");
    expect(calls[0].sql).toContain("ROW_NUMBER() OVER");
    expect(calls[0].sql).toContain("latest_rank = 1");
    expect(calls[1].sql).toContain("first_rank = 1");
    expect(calls[0].sql).not.toContain("SELECT COALESCE(fv2.pathname");
    expect(calls[0].sql).toContain("WHERE TRIM(value) != ''");
    expect(calls[0].bindings).toEqual([...visitBindings(), "Chrome", 5]);
    expect(calls[1].bindings).toEqual([...visitBindings(), "Chrome", 3]);
  });

  it("keeps entry and exit tab results while using one indexed visit source", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE visits (
        visit_id TEXT PRIMARY KEY, site_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL,
        last_activity_at INTEGER, ended_at INTEGER, finalized_at INTEGER,
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
      CREATE INDEX idx_visits_site_started_at
        ON visits(site_id, started_at);
    `);
    installVisitSiteIdentityFixture(database);
    const insert = database.prepare(`
      INSERT INTO visits (visit_id, site_id, visitor_id, session_id, started_at, pathname)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of [
      ["a-empty", "visitor-a", "session-a", baseMs, ""],
      ["a-entry", "visitor-a", "session-a", baseMs + 1, "/entry"],
      ["a-exit", "visitor-a", "session-a", baseMs + 2, "/exit"],
      ["b-only", "visitor-b", "session-b", baseMs + 3, "/pricing"],
      ["c-empty", "visitor-c", "session-c", baseMs + 4, ""],
    ] as const) {
      insert.run(row[0], siteId, row[1], row[2], row[3], row[4]);
    }

    const calls: QueryCall[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...bindings: QueryBinding[]) {
              calls.push({ sql, bindings });
              return {
                async all() {
                  return {
                    results: database.prepare(sql).all(...bindings),
                  };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
    } as Env;

    try {
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          10,
          "entry",
        ),
      ).resolves.toEqual([
        { value: "/entry", views: 1, sessions: 1, visitors: 1 },
        { value: "/pricing", views: 1, sessions: 1, visitors: 1 },
      ]);
      await expect(
        querySessionPathDimensionFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          10,
          "exit",
        ),
      ).resolves.toEqual([
        { value: "/exit", views: 1, sessions: 1, visitors: 1 },
        { value: "/pricing", views: 1, sessions: 1, visitors: 1 },
      ]);

      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(planDetails).toContain("MATERIALIZE filtered_visits");
      expect(planDetails).toContain("idx_visits_site_pk_started_at");
      expect(planDetails).not.toContain("CORRELATED SCALAR SUBQUERY");
    } finally {
      database.close();
    }
  });

  it("builds page tab entries while skipping rows without session ids or pathnames", async () => {
    const { env } = createD1Env([
      [
        {},
        {
          cardType: "path",
          value: "/first",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "path",
          value: "/last",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "path",
          value: "/anonymous",
          views: 1,
          sessions: 0,
          visitors: 1,
        },
        {
          cardType: "entry",
          value: "/first",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "exit",
          value: "/last",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    const tabs = await queryPageTabsFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      10,
    );

    expect(tabs.path).toEqual([
      { value: "/first", views: 1, sessions: 1, visitors: 1 },
      { value: "/last", views: 1, sessions: 1, visitors: 1 },
      { value: "/anonymous", views: 1, sessions: 0, visitors: 1 },
    ]);
    expect(tabs.entry).toEqual([
      { value: "/first", views: 1, sessions: 1, visitors: 1 },
    ]);
    expect(tabs.exit).toEqual([
      { value: "/last", views: 1, sessions: 1, visitors: 1 },
    ]);
  });

  it("materializes page tab visits once while preserving all tab results", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => {
            calls.push({ sql, bindings });
            return {
              all: async () => ({
                results: database.prepare(sql).all(...bindings) as D1Row[],
              }),
            };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, title, hostname
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)
    `);

    try {
      insert.run(
        "session-first",
        siteId,
        "visitor-a",
        "session-a",
        baseMs + 1,
        baseMs + 1,
        "/first",
        "First page",
        "app.example.test",
      );
      insert.run(
        "session-last",
        siteId,
        "visitor-a",
        "session-a",
        baseMs + 2,
        baseMs + 2,
        "/last",
        "Last page",
        "app.example.test",
      );
      insert.run(
        "anonymous",
        siteId,
        "visitor-b",
        "",
        baseMs + 3,
        baseMs + 3,
        "/anonymous",
        "Anonymous page",
        "other.example.test",
      );
      insert.run(
        "outside-window",
        siteId,
        "visitor-outside",
        "session-outside",
        window.endExclusiveMs,
        window.endExclusiveMs,
        "/outside",
        "Outside page",
        "outside.example.test",
      );

      await expect(
        queryPageTabsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10),
      ).resolves.toEqual({
        path: [
          { value: "/first", views: 1, sessions: 1, visitors: 1 },
          { value: "/last", views: 1, sessions: 1, visitors: 1 },
          { value: "/anonymous", views: 1, sessions: 0, visitors: 1 },
        ],
        title: [
          { value: "First page", views: 1, sessions: 1, visitors: 1 },
          { value: "Last page", views: 1, sessions: 1, visitors: 1 },
          { value: "Anonymous page", views: 1, sessions: 0, visitors: 1 },
        ],
        hostname: [
          { value: "app.example.test", views: 2, sessions: 1, visitors: 1 },
          { value: "other.example.test", views: 1, sessions: 0, visitors: 1 },
        ],
        entry: [{ value: "/first", views: 1, sessions: 1, visitors: 1 }],
        exit: [{ value: "/last", views: 1, sessions: 1, visitors: 1 }],
      });

      await expect(
        queryPageTabsFromD1(
          env,
          siteId,
          window,
          filterFixture({ path: "/last" }),
          10,
        ),
      ).resolves.toMatchObject({
        path: [{ value: "/last", views: 1, sessions: 1, visitors: 1 }],
        entry: [{ value: "/first", views: 1, sessions: 1, visitors: 1 }],
        exit: [{ value: "/last", views: 1, sessions: 1, visitors: 1 }],
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING")),
      ).toHaveLength(1);
      expect(
        plan.some((row) =>
          row.detail.includes("idx_visits_site_pk_started_at"),
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("normalizes client and geo dimensions with missing row values", async () => {
    const { env, calls } = createD1Env([
      [
        {},
        {
          cardType: "browser",
          value: "Safari",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "osVersion",
          value: "15",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "osVersion",
          value: "iOS",
          views: 1,
          sessions: 1,
        },
        {
          cardType: "screenSize",
          value: "390x844",
          views: 1,
          sessions: 1,
        },
      ],
      [
        {},
        {
          cardType: "continent",
          value: "NA",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [
        {
          cardType: "organization",
          value: "Example ISP",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    await expect(
      queryOverviewClientDimensionsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      ),
    ).resolves.toMatchObject({
      browser: [{ value: "Safari", views: 1, sessions: 1, visitors: 0 }],
      osVersion: [
        { value: "15", views: 1, sessions: 1, visitors: 0 },
        { value: "iOS", views: 1, sessions: 1, visitors: 0 },
      ],
      screenSize: [{ value: "390x844", views: 1, sessions: 1, visitors: 0 }],
    });
    await expect(
      queryOverviewGeoDimensionsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      ),
    ).resolves.toMatchObject({
      country: [],
      continent: [{ value: "NA", label: "NA" }],
      organization: [{ value: "Example ISP", label: "Example ISP" }],
    });
    expect(calls[0].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[1].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[2].bindings).toEqual([...visitBindings(), 10]);
    expect(calls[0].sql).toContain("filtered_visits AS MATERIALIZED");
    expect(calls[1].sql).toContain("filtered_visits AS MATERIALIZED");
    expect(calls[2].sql).toContain("filtered_visits AS MATERIALIZED");
    expect(calls[0].sql).toContain("ranked_cards AS");
    expect(calls[1].sql).toContain("ranked_cards AS");
    expect(calls[2].sql).toContain("ranked_cards AS");
    expect(calls.slice(1)).toHaveLength(2);
    for (const call of calls.slice(1)) {
      expect((call.sql.match(/UNION ALL/g) ?? []).length).toBeLessThan(5);
    }
  });
});

describe("edge query event fields and records low-level coverage", () => {
  it("queries event fields and skips D1 for unsupported field value types", async () => {
    const { env, calls, prepare } = createD1Env([
      [
        {
          path: "/plan",
          valueType: 1,
          events: 2,
          occurrences: 3,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
    ]);

    await expect(
      queryEventFieldsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        "Signup",
        9,
      ),
    ).resolves.toEqual([
      {
        path: "/plan",
        valueType: 1,
        events: 2,
        occurrences: 3,
        firstSeenAt: baseMs,
        lastSeenAt: baseMs + 1,
        stringValue: "pro",
        numberValue: null,
        booleanValue: null,
      },
    ]);
    await expect(
      queryEventFieldValuesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        "Signup",
        "/plan",
        "unsupported",
        5,
      ),
    ).resolves.toEqual([]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain("GROUP BY path, valueType");
    expect(calls[0].bindings).toEqual([
      siteId,
      "Signup",
      ...eventBindings(),
      9,
    ]);
  });

  it("binds event field value path, value type, filters, and limit", async () => {
    const { env, calls } = createD1Env([
      [
        {
          valueType: 2,
          events: "4",
          occurrences: "5",
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 2,
          stringValue: null,
          numberValue: 42,
          booleanValue: null,
        },
      ],
    ]);

    await expect(
      queryEventFieldValuesFromD1(
        env,
        siteId,
        window,
        filterFixture({ clientDeviceType: "mobile" }),
        "Purchase",
        "/amount",
        "number",
        7,
        "4",
      ),
    ).resolves.toEqual([
      {
        valueType: 2,
        events: "4",
        occurrences: "5",
        firstSeenAt: baseMs,
        lastSeenAt: baseMs + 2,
        stringValue: null,
        numberValue: 42,
        booleanValue: null,
      },
    ]);

    expect(calls[0].sql).toContain("WHERE p.path = ? AND v.value_type = ?");
    expect(calls[0].sql).toContain("LIKE ? ESCAPE '\\'");
    expect(calls[0].bindings).toEqual([
      siteId,
      "Purchase",
      ...eventBindings(),
      "mobile",
      "/amount",
      2,
      "%4%",
      7,
    ]);
  });

  it("returns null when an event detail record is missing", async () => {
    const { env, prepare } = createD1Env([[]]);

    await expect(
      queryEventRecordDetailFromD1(env, siteId, "missing-event"),
    ).resolves.toBeNull();

    expect(prepare).toHaveBeenCalledOnce();
    expect(readCustomEventDetailMock).not.toHaveBeenCalled();
  });

  it("defaults missing event detail payloads to an empty object", async () => {
    readCustomEventDetailMock.mockResolvedValueOnce(null);
    const { env } = createD1Env([[eventRecord()]]);

    await expect(
      queryEventRecordDetailFromD1(env, siteId, "evt-1"),
    ).resolves.toMatchObject({
      event: { eventId: "evt-1", eventName: "Signup" },
      context: {
        visitId: "visit-1",
        sessionId: "session-1",
        visitorId: "visitor-1",
      },
      eventData: {},
    });
  });
});

describe("edge query event handlers low-level coverage", () => {
  it("rejects event handler requests with missing identifiers or invalid windows", async () => {
    const { env, prepare } = createD1Env([]);

    const invalidTypes = await handleEventTypes(
      env,
      siteId,
      new URL("https://edge.test/event-types?from=20&to=10"),
    );
    const invalidSummary = await handleEventsSummary(
      env,
      siteId,
      new URL("https://edge.test/events-summary?from=20&to=10"),
    );
    const invalidTrend = await handleEventsTrend(
      env,
      siteId,
      new URL("https://edge.test/events-trend?from=20&to=10"),
    );
    const missingDetailName = await handleEventTypeDetail(
      env,
      siteId,
      url("/event-type-detail", {
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const invalidDetailWindow = await handleEventTypeDetail(
      env,
      siteId,
      url("/event-type-detail", { eventName: "Signup", from: 20, to: 10 }),
    );
    const missingFieldName = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        fieldPath: "/paid",
        fieldValueType: "boolean",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const missingFieldPath = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldValueType: "boolean",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const missingFieldType = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldPath: "/paid",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const missingEventId = await handleEventRecordDetail(
      env,
      siteId,
      new URL("https://edge.test/event-detail"),
    );

    await expect(invalidTypes.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(invalidSummary.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(invalidTrend.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(missingDetailName.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "eventName is required" },
    });
    await expect(invalidDetailWindow.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(missingFieldName.json()).resolves.toMatchObject({
      ok: true,
      fieldPath: "/paid",
      fieldValueType: "boolean",
      data: [],
    });
    await expect(missingFieldPath.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "fieldPath is required" },
    });
    await expect(missingFieldType.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "fieldValueType is required" },
    });
    await expect(missingEventId.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "eventId is required" },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("returns narrow field and context handler responses", async () => {
    const { env, calls } = createD1Env([
      [
        {
          path: "/plan",
          valueType: 1,
          events: 2,
          occurrences: 3,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
      [
        {
          cardType: "path",
          value: "/pricing",
          label: null,
          views: 2,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const { fields, context, detail } = await runWithInvocationLogger(
      logger,
      async () => ({
        fields: await handleEventTypeFields(
          env,
          siteId,
          url("/event-type-fields", {
            eventName: "Signup",
            from: window.startMs,
            to: window.endExclusiveMs,
          }),
        ),
        context: await handleEventTypeContext(
          env,
          siteId,
          url("/event-type-context", {
            eventName: "Signup",
            cards: "path",
            from: window.startMs,
            to: window.endExclusiveMs,
          }),
        ),
        detail: await handleEventTypeDetail(
          env,
          siteId,
          url("/event-type-detail", {
            eventName: "Signup",
            from: window.startMs,
            to: window.endExclusiveMs,
          }),
          undefined,
          undefined,
          {
            includeContext: false,
            includeBreakdowns: false,
            includeFields: false,
          },
        ),
      }),
    );

    await expect(fields.json()).resolves.toMatchObject({
      ok: true,
      eventName: "Signup",
      fields: [{ path: "/plan", valueType: "string", exampleValue: "pro" }],
    });
    await expect(context.json()).resolves.toMatchObject({
      ok: true,
      eventName: "Signup",
      cards: { page: { path: [{ label: "/pricing", views: 2 }] } },
    });
    await expect(detail.json()).resolves.toMatchObject({
      ok: true,
      fields: [],
      cards: { page: { path: [] } },
    });
    expect(calls).toHaveLength(4);
    expect(calls[1]?.sql).not.toContain("session_visit_edges");
  });

  it("maps event types from D1 rows", async () => {
    const { env, calls } = createD1Env([
      [{ value: "Signup", views: "6", sessions: "3", visitors: "2" }],
    ]);

    const response = await handleEventTypes(
      env,
      siteId,
      url("/event-types", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "Signup", views: 6, sessions: 3, visitors: 2 }],
    });
    expect(calls[0].bindings).toEqual([...eventBindings(), 4]);
  });

  it("uses a keyset cursor for event records and maps current rows", async () => {
    const { env, calls } = createD1Env([
      [
        { ...eventRecord({ eventId: "evt-1" }), eventPk: 11 },
        { ...eventRecord({ eventId: "evt-2" }), eventPk: 10 },
      ],
    ]);
    const cursor = serializeEventRecordCursor({
      sortKey: "eventName",
      sortDirection: "asc",
      sortValue: "Register",
      occurredAt: baseMs + 200,
      eventId: "evt-before",
      eventPk: 9,
    });

    const response = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.startMs,
        to: window.endExclusiveMs,
        pageSize: 1,
        sortBy: "eventName",
        sortDir: "asc",
        search: "signup",
        eventName: "Signup",
        cursor,
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ eventId: "evt-1", eventName: "Signup" }],
      meta: {
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextCursor: expect.any(String),
      },
    });
    expect(calls[0].sql).toContain("ORDER BY eventName ASC");
    expect(calls[0].sql).not.toContain("OFFSET");
    expect(calls[0].sql).toContain("target_event_name AS");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      siteId,
      "Signup",
      ...eventBindings(),
      ...Array<string>(8).fill("%signup%"),
      "Register",
      "Register",
      baseMs + 200,
      baseMs + 200,
      "evt-before",
      "evt-before",
      9,
      2,
    ]);
  });

  it("rejects invalid event record cursors before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const response = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.startMs,
        to: window.endExclusiveMs,
        pageSize: 120,
        cursor: "not-a-valid-cursor",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Invalid cursor" },
    });
    expect(calls).toHaveLength(0);
  });

  it("round-trips a cursor for the longest accepted UTF-8 pathname", () => {
    const sort = { key: "pathname", direction: "asc" } as const;
    const cursor = {
      sortKey: sort.key,
      sortDirection: sort.direction,
      sortValue: `/${"路".repeat(2_047)}`,
      occurredAt: baseMs,
      eventId: "evt-unicode",
      eventPk: 1,
    };

    const encoded = serializeEventRecordCursor(cursor);
    expect(encoded.length).toBeLessThanOrEqual(12_288);
    expect(parseEventRecordCursor(encoded, sort)).toEqual(cursor);
  });

  it("rejects malformed event record cursor fields", () => {
    const sort = { key: "eventName", direction: "asc" } as const;
    const cursor = {
      sortKey: sort.key,
      sortDirection: sort.direction,
      sortValue: "Signup",
      occurredAt: baseMs,
      eventId: "evt-valid",
      eventPk: 1,
    };
    const encode = (value: Record<string, unknown>) =>
      serializeEventRecordCursor(value as typeof cursor);

    expect(parseEventRecordCursor("!", sort)).toBeNull();
    expect(parseEventRecordCursor("a".repeat(12_289), sort)).toBeNull();
    expect(parseEventRecordCursor(btoa("[]"), sort)).toBeNull();
    expect(parseEventRecordCursor(btoa("null"), sort)).toBeNull();
    expect(
      parseEventRecordCursor(encode({ ...cursor, sortKey: "pathname" }), sort),
    ).toBeNull();
    expect(
      parseEventRecordCursor(
        encode({ ...cursor, sortDirection: "desc" }),
        sort,
      ),
    ).toBeNull();
    expect(
      parseEventRecordCursor(encode({ ...cursor, sortValue: true }), sort),
    ).toBeNull();
    expect(
      parseEventRecordCursor(encode({ ...cursor, sortValue: 1 }), sort),
    ).toBeNull();
    expect(
      parseEventRecordCursor(
        encode({ ...cursor, occurredAt: "invalid" }),
        sort,
      ),
    ).toBeNull();
    expect(
      parseEventRecordCursor(encode({ ...cursor, eventId: 1 }), sort),
    ).toBeNull();
    expect(
      parseEventRecordCursor(encode({ ...cursor, eventPk: -1 }), sort),
    ).toBeNull();
  });

  it("maps event summaries and final event record pages without more rows", async () => {
    const { env } = createD1Env([
      [
        {
          cardType: "__summary__",
          views: null,
          eventTypes: null,
          sessions: null,
          visitors: null,
        },
      ],
      [eventRecord({ eventId: "evt-final" })],
    ]);

    const summary = await handleEventsSummary(
      env,
      siteId,
      url("/events-summary", {
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );
    const records = await handleEventsRecords(
      env,
      siteId,
      url("/events-records", {
        from: window.startMs,
        to: window.endExclusiveMs,
        page: 1,
        pageSize: 2,
      }),
    );

    await expect(summary.json()).resolves.toMatchObject({
      ok: true,
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
      },
      cards: {
        event: { name: [] },
        page: { path: [], title: [], hostname: [] },
      },
    });
    await expect(records.json()).resolves.toMatchObject({
      ok: true,
      data: [{ eventId: "evt-final", eventName: "Signup" }],
      meta: {
        pageSize: 2,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    });
  });

  it("returns event field values and event detail handler payloads", async () => {
    readCustomEventDetailMock.mockResolvedValueOnce({
      siteId,
      eventId: "evt-1",
      visitId: "visit-1",
      eventName: "Signup",
      occurredAt: baseMs + 100,
      receivedAt: baseMs + 200,
      sequence: 1,
      nodeCount: 3,
      valueCount: 2,
      eventData: { plan: "pro" },
    });
    const { env } = createD1Env([
      [
        {
          valueType: 3,
          events: 2,
          occurrences: 2,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
          stringValue: null,
          numberValue: null,
          booleanValue: 1,
        },
      ],
      [eventRecord()],
    ]);

    const valuesResponse = await handleEventTypeFieldValues(
      env,
      siteId,
      url("/event-field-values", {
        eventName: "Signup",
        fieldPath: "/paid",
        fieldValueType: "boolean",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
    );
    const detailResponse = await handleEventRecordDetail(
      env,
      siteId,
      url("/event-detail", {
        eventId: "evt-1",
        from: window.startMs,
        to: window.endExclusiveMs,
      }),
    );

    await expect(valuesResponse.json()).resolves.toEqual({
      ok: true,
      fieldPath: "/paid",
      fieldValueType: "boolean",
      data: [
        {
          value: true,
          events: 2,
          occurrences: 2,
          firstSeenAt: baseMs,
          lastSeenAt: baseMs + 1,
        },
      ],
    });
    await expect(detailResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        event: { eventId: "evt-1", eventName: "Signup" },
        eventData: { plan: "pro" },
      },
    });
  });
});

describe("edge query event type overview low-level coverage", () => {
  it("uses zero summary fallbacks when scoped and event rows are empty", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        "Signup",
      ),
    ).resolves.toEqual({
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
      breakdowns: {
        pages: [],
        countries: [],
        devices: [],
        browsers: [],
      },
    });

    expect(calls).toHaveLength(1);
  });
});
