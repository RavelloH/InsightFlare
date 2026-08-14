import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { DashboardFilters, QueryWindow } from "@/lib/edge/query/core";
import {
  BROWSER_VERSION_UNKNOWN_TOKEN,
  clientDimensionDefinition,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/query/core";
import {
  parseClientDimensionKey,
  parseUtmDimensionKey,
  queryBrowserCrossDimensionFromD1,
  queryBrowserVersionBreakdownFromD1,
  queryShareTrendFromD1,
} from "@/lib/edge/query/technology";
import { queryCrossDimensionFromD1 } from "@/lib/edge/query/technology/client-cross";
import type { Env } from "@/lib/edge/types";

type D1Row = Record<string, unknown>;

interface QueryCall {
  sql: string;
  bindings: Array<string | number | null>;
}

function queryWindow(): QueryWindow {
  return {
    fromMs: Date.UTC(2026, 0, 1, 0, 10),
    toMs: Date.UTC(2026, 0, 1, 1, 10),
    nowMs: Date.UTC(2026, 0, 1, 2),
    timeZone: "UTC",
  };
}

function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const taggedShareResults =
    resultSets.length >= 3
      ? [
          ...resultSets[0].map((row) => ({ ...row, rowType: "top" })),
          ...resultSets[1].map((row) => ({ ...row, rowType: "series" })),
          ...resultSets[2].map((row) => ({ ...row, rowType: "bucket" })),
        ]
      : [];
  let taggedShareResultsConsumed = false;
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: Array<string | number | null>) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        if (sql.includes("tagged_rows") && !taggedShareResultsConsumed) {
          taggedShareResultsConsumed = true;
          return { results: taggedShareResults };
        }
        return { results: pendingResults.shift() ?? [] };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare },
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {},
    } as unknown as Env,
    calls,
  };
}

function visitBindings(siteId: string, window: QueryWindow) {
  return [siteId, window.fromMs, window.toMs];
}

type Binding = string | number | null;

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
  readonly calls: QueryCall[] = [];

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

function createSqliteTrendEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'closed',
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER,
      finalized_at INTEGER,
      duration_ms INTEGER,
      duration_source TEXT,
      exit_reason TEXT,
      pathname TEXT NOT NULL DEFAULT '',
      query_string TEXT NOT NULL DEFAULT '',
      hash_fragment TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      referrer_url TEXT NOT NULL DEFAULT '',
      referrer_host TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      utm_term TEXT NOT NULL DEFAULT '',
      utm_content TEXT NOT NULL DEFAULT '',
      is_eu INTEGER NOT NULL DEFAULT 0,
      country TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      region_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      continent TEXT NOT NULL DEFAULT '',
      latitude REAL,
      longitude REAL,
      postal_code TEXT NOT NULL DEFAULT '',
      metro_code TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '',
      as_organization TEXT NOT NULL DEFAULT '',
      ua_raw TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      browser_version TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '',
      device_type TEXT NOT NULL DEFAULT '',
      screen_width INTEGER,
      screen_height INTEGER,
      language TEXT NOT NULL DEFAULT '',
      perf_ttfb_ms REAL,
      perf_fcp_ms REAL,
      perf_lcp_ms REAL,
      perf_cls REAL,
      perf_inp_ms REAL,
      ae_synced_at INTEGER
    );
    CREATE INDEX idx_visits_site_started_at
      ON visits(site_id, started_at);
  `);
  return {
    env: {
      DB: d1 as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {},
    } as unknown as Env,
    d1,
  };
}

describe("edge query technology dimension parsers", () => {
  it("parses client dimension keys exactly after trimming", () => {
    expect(parseClientDimensionKey(" browser ")).toBe("browser");
    expect(parseClientDimensionKey("operatingSystem")).toBe("operatingSystem");
    expect(parseClientDimensionKey("osVersion")).toBe("osVersion");
    expect(parseClientDimensionKey("deviceType")).toBe("deviceType");
    expect(parseClientDimensionKey("language")).toBe("language");
    expect(parseClientDimensionKey("screenSize")).toBe("screenSize");

    expect(parseClientDimensionKey("Browser")).toBeNull();
    expect(parseClientDimensionKey("country")).toBeNull();
    expect(parseClientDimensionKey("")).toBeNull();
    expect(parseClientDimensionKey(null)).toBeNull();
  });

  it("parses UTM dimension keys exactly after trimming", () => {
    expect(parseUtmDimensionKey(" source ")).toBe("source");
    expect(parseUtmDimensionKey("medium")).toBe("medium");
    expect(parseUtmDimensionKey("campaign")).toBe("campaign");
    expect(parseUtmDimensionKey("term")).toBe("term");
    expect(parseUtmDimensionKey("content")).toBe("content");

    expect(parseUtmDimensionKey("utm_source")).toBeNull();
    expect(parseUtmDimensionKey("Source")).toBeNull();
    expect(parseUtmDimensionKey("")).toBeNull();
    expect(parseUtmDimensionKey(null)).toBeNull();
  });
});

describe("edge query technology D1 mapping", () => {
  it("executes the consolidated share trend SQL against a SQLite fixture", async () => {
    const { env, d1 } = createSqliteTrendEnv();
    const window = queryWindow();
    const insert = d1.database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, country,
        device_type, browser
      ) VALUES (?, 'site-1', ?, ?, ?, ?, ?, ?)
    `);
    const at = (minute: number) => Date.UTC(2026, 0, 1, 0, minute);

    insert.run(
      "alpha-first",
      "alpha",
      "alpha-session",
      at(15),
      "US",
      "desktop",
      "Chrome",
    );
    insert.run(
      "alpha-last",
      "alpha",
      "alpha-session",
      at(65),
      "US",
      "desktop",
      "Firefox",
    );
    insert.run(
      "bravo",
      "bravo",
      "bravo-session",
      at(55),
      "US",
      "desktop",
      "Chrome",
    );
    insert.run(
      "charlie",
      "charlie",
      "charlie-session",
      at(20),
      "US",
      "desktop",
      "Safari",
    );
    insert.run(
      "excluded-country",
      "delta",
      "delta-session",
      at(30),
      "CA",
      "desktop",
      "Edge",
    );
    insert.run(
      "empty-visitor",
      "",
      "anonymous-session",
      at(45),
      "US",
      "desktop",
      "Opera",
    );

    try {
      await expect(
        queryShareTrendFromD1(
          env,
          "site-1",
          window,
          "hour",
          { country: "US", clientDeviceType: "desktop" },
          2,
          "TRIM(COALESCE(browser, ''))",
          "browser",
        ),
      ).resolves.toEqual({
        series: [
          {
            key: "firefox",
            label: "Firefox",
            views: 2,
            visitors: 1,
            sessions: 1,
          },
          {
            key: "chrome",
            label: "Chrome",
            views: 1,
            visitors: 1,
            sessions: 1,
          },
          {
            key: "other",
            label: SHARE_TREND_OTHER_LABEL,
            views: 1,
            visitors: 1,
            sessions: 1,
            isOther: true,
          },
        ],
        data: [
          {
            bucket: 0,
            timestampMs: Date.UTC(2026, 0, 1, 0),
            totalVisitors: 3,
            visitorsBySeries: { firefox: 0, chrome: 2, other: 1 },
          },
          {
            bucket: 1,
            timestampMs: Date.UTC(2026, 0, 1, 1),
            totalVisitors: 1,
            visitorsBySeries: { firefox: 1, chrome: 0, other: 0 },
          },
        ],
      });

      expect(d1.calls).toHaveLength(1);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${d1.calls[0].sql}`)
        .all(...d1.calls[0].bindings) as Array<{ detail: string }>;
      expect(
        plan.some((row) => row.detail.includes("idx_visits_site_started_at")),
      ).toBe(true);
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("executes the consolidated client cross SQL against a SQLite fixture", async () => {
    const { env, d1 } = createSqliteTrendEnv();
    const window = queryWindow();
    const insert = d1.database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, browser, device_type
      ) VALUES (?, 'site-1', ?, ?, ?, ?, ?)
    `);
    const at = (minute: number) => Date.UTC(2026, 0, 1, 0, minute);

    insert.run(
      "chrome-desktop-1",
      "chrome-1",
      "session-1",
      at(15),
      "Chrome",
      "desktop",
    );
    insert.run(
      "chrome-desktop-2",
      "chrome-2",
      "session-2",
      at(20),
      "Chrome",
      "desktop",
    );
    insert.run(
      "chrome-mobile",
      "chrome-3",
      "session-3",
      at(25),
      "Chrome",
      "mobile",
    );
    insert.run("edge-desktop", "edge", "session-4", at(30), "Edge", "desktop");
    insert.run(
      "safari-mobile",
      "safari",
      "session-5",
      at(35),
      "Safari",
      "mobile",
    );
    insert.run(
      "outside-window",
      "outside",
      "session-6",
      at(5),
      "Chrome",
      "desktop",
    );

    try {
      await expect(
        queryCrossDimensionFromD1(
          env,
          "site-1",
          window,
          {},
          2,
          1,
          clientDimensionDefinition("browser"),
          clientDimensionDefinition("deviceType"),
        ),
      ).resolves.toEqual({
        columns: [
          {
            key: "desktop",
            label: "desktop",
            views: 3,
            visitors: 3,
            sessions: 3,
          },
          {
            key: "other",
            label: SHARE_TREND_OTHER_LABEL,
            views: 2,
            visitors: 2,
            sessions: 2,
            isOther: true,
          },
        ],
        rows: [
          {
            key: "chrome",
            label: "Chrome",
            views: 3,
            visitors: 3,
            sessions: 3,
            cells: [
              {
                key: "desktop",
                label: "desktop",
                views: 2,
                visitors: 2,
                sessions: 2,
              },
              {
                key: "other",
                label: SHARE_TREND_OTHER_LABEL,
                views: 1,
                visitors: 1,
                sessions: 1,
                isOther: true,
              },
            ],
          },
          {
            key: "edge",
            label: "Edge",
            views: 1,
            visitors: 1,
            sessions: 1,
            cells: [
              {
                key: "desktop",
                label: "desktop",
                views: 1,
                visitors: 1,
                sessions: 1,
              },
              {
                key: "other",
                label: SHARE_TREND_OTHER_LABEL,
                views: 0,
                visitors: 0,
                sessions: 0,
                isOther: true,
              },
            ],
          },
          {
            key: "other",
            label: SHARE_TREND_OTHER_LABEL,
            views: 1,
            visitors: 1,
            sessions: 1,
            isOther: true,
            cells: [
              {
                key: "desktop",
                label: "desktop",
                views: 0,
                visitors: 0,
                sessions: 0,
              },
              {
                key: "other",
                label: SHARE_TREND_OTHER_LABEL,
                views: 1,
                visitors: 1,
                sessions: 1,
                isOther: true,
              },
            ],
          },
        ],
        totalVisitors: 5,
      });

      expect(d1.calls).toHaveLength(1);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${d1.calls[0].sql}`)
        .all(...d1.calls[0].bindings) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("executes the consolidated browser cross SQL against a SQLite fixture", async () => {
    const { env, d1 } = createSqliteTrendEnv();
    const window = queryWindow();
    const insert = d1.database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, browser, os
      ) VALUES (?, 'site-1', ?, ?, ?, ?, ?)
    `);
    const at = (minute: number) => Date.UTC(2026, 0, 1, 0, minute);

    insert.run(
      "chrome-windows-1",
      "chrome-1",
      "session-1",
      at(15),
      "Chrome",
      "Windows",
    );
    insert.run(
      "chrome-windows-2",
      "chrome-2",
      "session-2",
      at(20),
      "Chrome",
      "Windows",
    );
    insert.run(
      "chrome-mac",
      "chrome-3",
      "session-3",
      at(25),
      "Chrome",
      "macOS",
    );
    insert.run("edge-windows", "edge", "session-4", at(30), "Edge", "Windows");
    insert.run("safari-mac", "safari", "session-5", at(35), "Safari", "macOS");
    insert.run(
      "outside-window",
      "outside",
      "session-6",
      at(5),
      "Chrome",
      "Windows",
    );

    try {
      const result = await queryBrowserCrossDimensionFromD1(
        env,
        "site-1",
        window,
        {},
        2,
        1,
        "TRIM(COALESCE(os, ''))",
        "os",
      );

      expect(result.columns).toEqual([
        {
          key: "windows",
          label: "Windows",
          views: 3,
          visitors: 3,
          sessions: 3,
        },
        {
          key: "other",
          label: SHARE_TREND_OTHER_LABEL,
          views: 2,
          visitors: 2,
          sessions: 2,
          isOther: true,
        },
      ]);
      expect(result.rows).toMatchObject([
        {
          key: "chrome",
          views: 3,
          visitors: 3,
          cells: [
            { key: "windows", views: 2, visitors: 2 },
            { key: "other", views: 1, visitors: 1, isOther: true },
          ],
        },
        {
          key: "edge",
          views: 1,
          visitors: 1,
          cells: [
            { key: "windows", views: 1, visitors: 1 },
            { key: "other", views: 0, visitors: 0, isOther: true },
          ],
        },
        {
          key: "other",
          views: 1,
          visitors: 1,
          isOther: true,
          cells: [
            { key: "windows", views: 0, visitors: 0 },
            { key: "other", views: 1, visitors: 1, isOther: true },
          ],
        },
      ]);
      expect(result.totalVisitors).toBe(5);
      expect(d1.calls).toHaveLength(1);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${d1.calls[0].sql}`)
        .all(...d1.calls[0].bindings) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
      ).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("maps browser version breakdown rows and captures SQL bindings", async () => {
    const siteId = "site-1";
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        {
          browser: "Chrome",
          views: 50,
          visitors: 25,
          sessions: 20,
          version: "124",
          versionViews: 30,
          versionVisitors: 20,
          versionSessions: 18,
        },
        {
          browser: "Chrome",
          views: 50,
          visitors: 25,
          sessions: 20,
          version: BROWSER_VERSION_UNKNOWN_TOKEN,
          versionViews: 8,
          versionVisitors: 3,
          versionSessions: 2,
        },
        {
          browser: "Chrome",
          views: 50,
          visitors: 25,
          sessions: 20,
          version: "123",
          versionViews: 4,
          versionVisitors: 2,
          versionSessions: 2,
        },
        {
          browser: "Chrome",
          views: 50,
          visitors: 25,
          sessions: 20,
          version: "122",
          versionViews: 1,
          versionVisitors: 1,
          versionSessions: 1,
        },
        {
          browser: "Safari",
          views: 10,
          visitors: 5,
          sessions: 4,
          version: "17",
          versionViews: 9,
          versionVisitors: 5,
          versionSessions: 4,
        },
        {
          browser: "NoVisitors",
          views: 99,
          visitors: 0,
          sessions: 0,
          version: "",
          versionViews: 0,
          versionVisitors: 0,
          versionSessions: 0,
        },
      ],
    ]);

    const result = await queryBrowserVersionBreakdownFromD1(
      env,
      siteId,
      window,
      {},
      2,
      2,
    );

    expect(result).toEqual([
      {
        browser: "Chrome",
        views: 50,
        visitors: 25,
        sessions: 20,
        versions: [
          { key: "124", label: "124", views: 30, visitors: 20, sessions: 18 },
          {
            key: "unknown",
            label: "Unknown",
            views: 8,
            visitors: 3,
            sessions: 2,
            isUnknown: true,
          },
          {
            key: "other",
            label: SHARE_TREND_OTHER_LABEL,
            views: 5,
            visitors: 3,
            sessions: 3,
            isOther: true,
          },
        ],
      },
      {
        browser: "Safari",
        views: 10,
        visitors: 5,
        sessions: 4,
        versions: [
          { key: "17", label: "17", views: 9, visitors: 5, sessions: 4 },
        ],
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("WHERE browser != ''");
    expect(calls[0].sql).toContain("browserRank <= ?");
    expect(calls[0].bindings).toEqual([...visitBindings(siteId, window), 2]);
    expect(calls[0].sql).toContain(BROWSER_VERSION_UNKNOWN_TOKEN);
  });

  it("maps shared trend rows with top labels, other bucket, filters, and time buckets", async () => {
    const siteId = "site-1";
    const window = queryWindow();
    const filters: DashboardFilters = {
      country: "US",
      clientDeviceType: "desktop",
    };
    const { env, calls } = createD1Env([
      [
        { label: "Chrome", views: "12", visitors: "7", sessions: "5" },
        { label: "Firefox", views: 4, visitors: 2, sessions: 2 },
        { label: "", views: 10, visitors: 4, sessions: 4 },
      ],
      [
        { label: "Chrome", views: 13, visitors: 8, sessions: 6 },
        { label: "Firefox", views: 4, visitors: 2, sessions: 2 },
        {
          label: SHARE_TREND_OTHER_TOKEN,
          views: 3,
          visitors: 1,
          sessions: 1,
        },
        { label: "NoVisitors", views: 99, visitors: 0, sessions: 0 },
      ],
      [
        { bucket: 0, label: "Chrome", views: 6, visitors: 4, sessions: 3 },
        {
          bucket: 0,
          label: SHARE_TREND_OTHER_TOKEN,
          views: 1,
          visitors: 1,
          sessions: 1,
        },
        { bucket: 1, label: "Firefox", views: 4, visitors: 2, sessions: 2 },
        { bucket: 1, label: "Ignored", views: 2, visitors: 1, sessions: 1 },
      ],
    ]);

    const result = await queryShareTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      filters,
      99,
      "TRIM(COALESCE(browser, ''))",
      "browser",
    );

    expect(result.series).toEqual([
      { key: "chrome", label: "Chrome", views: 13, visitors: 8, sessions: 6 },
      { key: "firefox", label: "Firefox", views: 4, visitors: 2, sessions: 2 },
      {
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: 3,
        visitors: 1,
        sessions: 1,
        isOther: true,
      },
    ]);
    expect(result.data).toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 1, 0),
        totalVisitors: 5,
        visitorsBySeries: { chrome: 4, firefox: 0, other: 1 },
      },
      {
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 1, 1),
        totalVisitors: 2,
        visitorsBySeries: { chrome: 0, firefox: 2, other: 0 },
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("TRIM(COALESCE(browser, '')) AS labelValue");
    expect(calls[0].sql).toContain("LOWER(TRIM(COALESCE(country, ''))) = ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(siteId, window),
      "us",
      "desktop",
      12,
    ]);
    expect(calls[0].sql).toContain("top_rows");
    expect(calls[0].sql).toContain("bucket_rows");
    expect(calls[0].sql).toContain("tagged_rows");
  });
});
