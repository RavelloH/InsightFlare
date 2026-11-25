import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { FilterDocument } from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { handlePerformanceContract as handlePerformance } from "@/lib/edge/analytics/interfaces/dashboard/protocol/analysis";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceDashboardFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
  queryPerformanceTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";
import { installVisitSiteIdentityFixture } from "./site-identity-fixture";
interface PreparedQuery {
  sql: string;
  bindings: Array<string | number | null>;
}
function createD1Env(rowSets: Record<string, unknown>[][] = []) {
  const calls: PreparedQuery[] = [];
  const prepare = vi.fn((sql: string) => {
    const call: PreparedQuery = { sql, bindings: [] };
    calls.push(call);
    return {
      bind: vi.fn((...bindings: Array<string | number | null>) => {
        call.bindings = bindings;
        return {
          all: vi.fn(async () => ({ results: rowSets.shift() ?? [] })),
        };
      }),
    };
  });

  return {
    env: { DB: { prepare } as unknown as D1Database } as Env,
    calls,
    prepare,
  };
}
type D1Row = Record<string, unknown>;
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
  readonly calls: PreparedQuery[] = [];

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
function createSqlitePerformanceEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      visitor_id TEXT, session_id TEXT, status TEXT, started_at INTEGER,
      last_activity_at INTEGER, ended_at INTEGER, finalized_at INTEGER,
      duration_ms INTEGER, duration_source TEXT, exit_reason TEXT,
      pathname TEXT, query_string TEXT, hash_fragment TEXT, hostname TEXT,
      title TEXT, referrer_url TEXT, referrer_host TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT,
      utm_content TEXT, is_eu INTEGER, country TEXT, region TEXT,
      region_code TEXT, city TEXT, continent TEXT, latitude REAL,
      longitude REAL, postal_code TEXT, metro_code TEXT, timezone TEXT,
      as_organization TEXT, ua_raw TEXT, browser TEXT, browser_version TEXT,
      os TEXT, os_version TEXT, device_type TEXT, screen_width INTEGER,
      screen_height INTEGER, language TEXT, user_id TEXT, user_name TEXT,
      perf_ttfb_ms REAL,
      perf_fcp_ms REAL, perf_lcp_ms REAL, perf_cls REAL, perf_inp_ms REAL,
      ae_synced_at INTEGER
    );
    CREATE INDEX idx_visits_site_started_at
      ON visits(site_id, started_at);
  `);
  installVisitSiteIdentityFixture(d1.database);
  d1.database.exec(`
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL DEFAULT 1,
      visit_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      node_count INTEGER NOT NULL,
      value_count INTEGER NOT NULL,
      ae_synced_at INTEGER
    );
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
const siteId = "site-1";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 2, 1, 30),
  endExclusiveMs: Date.UTC(2026, 0, 2, 3, 5),
  nowMs: Date.UTC(2026, 0, 2, 3, 5),
  timeZone: "UTC",
};
const visitBindings = [siteId, window.startMs, window.endExclusiveMs];
describe("edge query performance D1 helpers", () => {
  it("maps metric summaries, leaves missing metrics empty, and binds filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          metric: "ttfb",
          samples: "4",
          avgValue: "50.1234",
          p50: 40,
          p75: 60.9876,
          p95: 80.4567,
        },
        {
          metric: "lcp",
          samples: 8,
          avgValue: 123.4567,
          p50: 100,
          p75: 150.1114,
          p95: 250.9999,
        },
        {
          metric: "unknown",
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
      ],
    ]);
    const filters: FilterDocument = filterFixture({
      country: "US",
      hostname: "Example.COM",
      clientDeviceType: "desktop",
    });

    const result = await queryPerformanceSummariesFromD1(
      env,
      siteId,
      window,
      filters,
    );

    expect(result).toEqual({
      ttfb: { avg: 50.123, p50: 40, p75: 60.988, p95: 80.457, samples: 4 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: {
        avg: 123.457,
        p50: 100,
        p75: 150.111,
        p95: 251,
        samples: 8,
      },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("GROUP BY metric");
    expect(calls[0]?.sql).toContain("COUNT(*) AS samples");
    expect(calls[0]?.sql).toContain("CUME_DIST() OVER");
    expect(calls[0]?.sql).not.toContain("ROW_NUMBER() OVER");
    expect(calls[0]?.sql).not.toContain("metric_thresholds AS");
    expect(calls[0]?.sql).toContain("FROM visits");
    expect(calls[0]?.sql).toContain("perf_cls AS metricValue");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings,
      "desktop",
      "us",
      "example.com",
      window.startMs,
      window.endExclusiveMs,
      "desktop",
      "us",
      "example.com",
    ]);
  });

  it("normalizes sparse metric summary rows", async () => {
    const { env } = createD1Env([
      [
        {
          metric: "ttfb",
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        },
        {
          metric: null,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
      ],
    ]);

    const result = await queryPerformanceSummariesFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
    );

    expect(result.ttfb).toEqual({
      avg: 0,
      p50: null,
      p75: 0,
      p95: null,
      samples: 0,
    });
    expect(result.fcp).toEqual({
      avg: null,
      p50: null,
      p75: null,
      p95: null,
      samples: 0,
    });
  });

  it("maps metric trend buckets and constrains the requested metric column", async () => {
    const { env, calls } = createD1Env([
      [
        {
          bucket: "0",
          samples: "3",
          avgValue: 100.3333,
          p50: 80,
          p75: 120.5555,
          p95: 250.9999,
        },
        {
          bucket: 1,
          samples: 5,
          avgValue: "200",
          p50: 190,
          p75: 220,
          p95: 250,
        },
      ],
    ]);

    const result = await queryPerformanceTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      filterFixture({ path: "/pricing" }),
      "lcp",
    );

    expect(result).toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        avg: 100.333,
        p50: 80,
        p75: 120.556,
        p95: 251,
        samples: 3,
      },
      {
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        avg: 200,
        p50: 190,
        p75: 220,
        p95: 250,
        samples: 5,
      },
    ]);
    expect(calls[0]?.sql).toContain("perf_lcp_ms AS metricValue");
    expect(calls[0]?.sql).toContain("perf_lcp_ms IS NOT NULL");
    expect(calls[0]?.sql).toContain("ORDER BY bucket ASC");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings,
      "/pricing",
      window.startMs,
      window.endExclusiveMs,
      "/pricing",
    ]);
  });

  it("normalizes sparse metric trend rows", async () => {
    const { env } = createD1Env([
      [
        {
          bucket: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        },
      ],
    ]);

    await expect(
      queryPerformanceTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        "ttfb",
      ),
    ).resolves.toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        avg: 0,
        p50: null,
        p75: 0,
        p95: null,
        samples: 0,
      },
    ]);
  });

  it("queries and groups every metric trend in one D1 statement", async () => {
    const { env, calls } = createD1Env([
      [
        {
          metric: "lcp",
          bucket: 0,
          samples: 3,
          avgValue: 100.3333,
          p50: 80,
          p75: 120.5555,
          p95: 250.9999,
        },
        {
          metric: "ttfb",
          bucket: 1,
          samples: 2,
          avgValue: 50,
          p50: 40,
          p75: 60,
          p95: 70,
        },
        { metric: "unknown", bucket: 0, samples: 99 },
      ],
    ]);

    const result = await queryAllPerformanceTrendsFromD1(
      env,
      siteId,
      window,
      "hour",
      filterFixture({ country: "US" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("PARTITION BY metric, bucket");
    expect(calls[0]?.sql).toContain("'ttfb' AS metric");
    expect(calls[0]?.sql).toContain("'inp' AS metric");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings,
      "us",
      window.startMs,
      window.endExclusiveMs,
      "us",
    ]);
    expect(result.lcp).toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        avg: 100.333,
        p50: 80,
        p75: 120.556,
        p95: 251,
        samples: 3,
      },
    ]);
    expect(result.ttfb).toHaveLength(1);
    expect(result.fcp).toEqual([]);
    expect(result.cls).toEqual([]);
    expect(result.inp).toEqual([]);
  });

  it("groups route metrics by normalized pathname and preserves empty metric buckets", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: " /pricing ",
          metric: "lcp",
          views: "9",
          samples: "3",
          avgValue: 100.4444,
          p50: 90,
          p75: 120,
          p95: 150,
        },
        {
          pathname: "/pricing",
          metric: "ttfb",
          views: 9,
          samples: 2,
          avgValue: 50,
          p50: 40,
          p75: 60,
          p95: 70,
        },
        {
          pathname: "",
          metric: "fcp",
          views: 2,
          samples: 1,
          avgValue: 80,
          p50: 80,
          p75: 80,
          p95: 80,
        },
        {
          pathname: "/ignored",
          metric: "bad",
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
      ],
    ]);

    const result = await queryPerformanceRoutesFromD1(
      env,
      siteId,
      window,
      filterFixture({ browser: "Chrome" }),
      2,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      pathname: "/pricing",
      views: 9,
      metrics: {
        ttfb: { avg: 50, p50: 40, p75: 60, p95: 70, samples: 2 },
        lcp: { avg: 100.444, p50: 90, p75: 120, p95: 150, samples: 3 },
        cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(result[1]).toMatchObject({
      pathname: "/",
      views: 2,
      metrics: {
        fcp: { avg: 80, p50: 80, p75: 80, p95: 80, samples: 1 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(calls[0]?.sql).toContain("path_views AS");
    expect(calls[0]?.sql).toContain("top_metric_visits AS MATERIALIZED");
    expect(calls[0]?.sql).toContain(
      "WHERE pathname IN (SELECT pathname FROM path_views)",
    );
    expect(calls[0]?.sql).toContain("AND has_any_performance = 1");
    expect(calls[0]?.sql).toContain("FROM top_metric_visits");
    expect(calls[0]?.sql).toContain("LIMIT ?");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings,
      "Chrome",
      window.startMs,
      window.endExclusiveMs,
      "Chrome",
      2,
    ]);
  });

  it("normalizes sparse route metric rows", async () => {
    const { env } = createD1Env([
      [
        {
          pathname: null,
          metric: "ttfb",
          views: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        },
        {
          pathname: "/ignored",
          metric: null,
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
      ],
    ]);

    await expect(
      queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        1,
      ),
    ).resolves.toMatchObject([
      {
        pathname: "/",
        views: 0,
        metrics: {
          ttfb: {
            avg: 0,
            p50: null,
            p75: 0,
            p95: null,
            samples: 0,
          },
        },
      },
    ]);
  });

  it("groups country metrics by uppercase country and skips invalid rows", async () => {
    const { env, calls } = createD1Env([
      [
        {
          country: " us ",
          metric: "ttfb",
          views: "6",
          samples: "3",
          avgValue: 30.3333,
          p50: 20,
          p75: 40,
          p95: 50,
        },
        {
          country: "US",
          metric: "cls",
          views: 6,
          samples: 1,
          avgValue: 0.1234,
          p50: 0.1,
          p75: 0.12,
          p95: 0.2,
        },
        {
          country: "ca",
          metric: "fcp",
          views: 2,
          samples: 1,
          avgValue: 111.1111,
          p50: 111.1111,
          p75: 111.1111,
          p95: 111.1111,
        },
        {
          country: "",
          metric: "lcp",
          views: 1,
          samples: 1,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
        {
          country: "MX",
          metric: "bad",
          views: 1,
          samples: 1,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
      ],
    ]);

    const result = await queryPerformanceCountriesFromD1(
      env,
      siteId,
      window,
      filterFixture({
        geoContinent: "NA",
        geoOrganization: "Example ISP",
      }),
      10,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      country: "US",
      views: 6,
      metrics: {
        ttfb: { avg: 30.333, p50: 20, p75: 40, p95: 50, samples: 3 },
        cls: { avg: 0.123, p50: 0.1, p75: 0.12, p95: 0.2, samples: 1 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      },
    });
    expect(result[1]).toMatchObject({
      country: "CA",
      views: 2,
      metrics: {
        fcp: {
          avg: 111.111,
          p50: 111.111,
          p75: 111.111,
          p95: 111.111,
          samples: 1,
        },
      },
    });
    expect(calls[0]?.sql).toContain("country_views AS");
    expect(calls[0]?.sql).toContain("top_metric_visits AS MATERIALIZED");
    expect(calls[0]?.sql).toContain(
      "WHERE country IN (SELECT country FROM country_views)",
    );
    expect(calls[0]?.sql).toContain("AND has_any_performance = 1");
    expect(calls[0]?.sql).toContain("UPPER(TRIM(COALESCE(country, '')))");
    expect(calls[0]?.bindings).toEqual([
      ...visitBindings,
      "na",
      "Example ISP",
      window.startMs,
      window.endExclusiveMs,
      "na",
      "Example ISP",
      10,
    ]);
  });

  it("normalizes sparse country metric rows", async () => {
    const { env } = createD1Env([
      [
        {
          country: null,
          metric: "ttfb",
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
        {
          country: "US",
          metric: null,
          views: 99,
          samples: 99,
          avgValue: 999,
          p50: 999,
          p75: 999,
          p95: 999,
        },
        {
          country: "ca",
          metric: "lcp",
          views: null,
          samples: null,
          avgValue: null,
          p50: undefined,
          p75: null,
          p95: undefined,
        },
      ],
    ]);

    await expect(
      queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      ),
    ).resolves.toMatchObject([
      {
        country: "CA",
        views: 0,
        metrics: {
          lcp: {
            avg: 0,
            p50: null,
            p75: 0,
            p95: null,
            samples: 0,
          },
        },
      },
    ]);
  });

  it("materializes each shared performance source without changing percentile results", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    const insert = d1.database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, started_at, pathname, country,
        perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
      ) VALUES (?, 'site-1', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const at = (minutes: number) => Date.UTC(2026, 0, 2, 1, 30 + minutes);

    insert.run(
      "pricing-fast",
      at(5),
      "/pricing",
      "us",
      50,
      null,
      100,
      0.2,
      null,
    );
    insert.run(
      "pricing-slow",
      at(10),
      " /pricing ",
      "US",
      100,
      null,
      200,
      0.1,
      50,
    );
    insert.run("blog", at(40), "/blog", " ca ", 150, 80, 300, null, 100);
    insert.run(
      "pricing-without-performance",
      at(45),
      "/pricing",
      "US",
      null,
      null,
      null,
      null,
      null,
    );
    insert.run("unknown", at(50), "", "", null, null, null, null, null);
    insert.run("outside-window", at(-1), "/outside", "US", 1, 1, 1, 1, 1);
    insert.run(
      "end-exclusive",
      window.endExclusiveMs,
      "/excluded",
      "US",
      1,
      1,
      1,
      1,
      1,
    );

    try {
      await expect(
        queryPerformanceSummariesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
        ),
      ).resolves.toMatchObject({
        ttfb: { avg: 100, p50: 100, p75: 150, p95: 150, samples: 3 },
        lcp: { avg: 200, p50: 200, p75: 300, p95: 300, samples: 3 },
        fcp: { avg: 80, p50: 80, p75: 80, p95: 80, samples: 1 },
      });
      await expect(
        queryAllPerformanceTrendsFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
        ),
      ).resolves.toMatchObject({
        ttfb: [
          { bucket: 0, avg: 75, p50: 50, p75: 100, p95: 100, samples: 2 },
          { bucket: 1, avg: 150, p50: 150, p75: 150, p95: 150, samples: 1 },
        ],
      });
      await expect(
        queryPerformanceRoutesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          1,
        ),
      ).resolves.toMatchObject([
        {
          pathname: "/pricing",
          views: 3,
          metrics: {
            ttfb: { avg: 75, p50: 50, p75: 100, p95: 100, samples: 2 },
          },
        },
      ]);
      await expect(
        queryPerformanceCountriesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          10,
        ),
      ).resolves.toMatchObject([
        {
          country: "US",
          views: 3,
          metrics: {
            lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 2 },
          },
        },
        {
          country: "CA",
          views: 1,
          metrics: {
            inp: { avg: 100, p50: 100, p75: 100, p95: 100, samples: 1 },
          },
        },
      ]);

      expect(d1.calls).toHaveLength(4);
      for (const call of d1.calls) {
        expect(call.sql).toContain("AS MATERIALIZED");
        const plan = d1.database
          .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
          .all(...call.bindings) as Array<{ detail: string }>;
        expect(
          plan.filter((row) =>
            row.detail.includes("SEARCH visits USING INDEX"),
          ),
        ).toHaveLength(1);
      }

      const response = await handlePerformance(
        env,
        siteId,
        new URL(
          `https://edge.test/performance?from=${window.startMs}&to=${window.endExclusiveMs}&interval=hour`,
        ),
      );
      const payload = (await response.json()) as {
        summaries: Record<string, { p50: number | null }>;
        trends: Record<string, Array<{ bucket: number; p50: number | null }>>;
        routes: Array<{ pathname: string; views: number }>;
        countries: Array<{ country: string; views: number }>;
      };
      expect(payload.summaries.ttfb).toMatchObject({ p50: 100 });
      expect(payload.trends.ttfb?.[0]).toMatchObject({ bucket: 0, p50: 50 });
      expect(payload.routes[0]).toMatchObject({
        pathname: "/pricing",
        views: 3,
      });
      expect(payload.countries[0]).toMatchObject({ country: "US", views: 3 });
      expect(d1.calls).toHaveLength(5);
      const dashboardPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${d1.calls[4]?.sql}`)
        .all(...(d1.calls[4]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        dashboardPlan.filter((row) =>
          row.detail.includes("SEARCH visits USING INDEX"),
        ),
      ).toHaveLength(1);
      expect(d1.calls[4]?.sql).toContain("performance_visits AS MATERIALIZED");
      expect(d1.calls[4]?.sql).toContain(
        "perf_ttfb_ms IS NOT NULL OR perf_fcp_ms IS NOT NULL",
      );
      const limitedCountries = await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        1,
      );
      expect(limitedCountries).toHaveLength(1);
      expect(limitedCountries[0]).toMatchObject({
        country: "US",
        views: 3,
        metrics: {
          lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 2 },
        },
      });
      expect(d1.calls[5]?.sql).toContain("ORDER BY views DESC, country ASC");
      expect(d1.calls[5]?.bindings.at(-1)).toBe(1);
      const focusedCountries = await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        1,
        "lcp",
      );
      expect(focusedCountries).toHaveLength(1);
      expect(focusedCountries[0]).toMatchObject({
        country: "US",
        views: 3,
        metrics: {
          lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 2 },
          ttfb: { samples: 0 },
        },
      });
      expect(d1.calls[6]?.sql).not.toContain("UNION ALL");
      expect(d1.calls[6]?.sql).not.toContain("perf_ttfb_ms AS metricValue");
      expect(d1.calls[6]?.sql).toContain("perf_lcp_ms AS metricValue");
      const focusedRoutes = await queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        1,
        "lcp",
      );
      expect(focusedRoutes[0]).toMatchObject({
        pathname: "/pricing",
        views: 3,
        metrics: {
          lcp: { avg: 150, p50: 100, p75: 200, p95: 200, samples: 2 },
          ttfb: { samples: 0 },
        },
      });
      expect(d1.calls[7]?.sql).not.toContain("UNION ALL");
    } finally {
      d1.close();
    }
  });

  it("keeps dimensions with other vitals but no samples for the requested metric", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    try {
      const insert = d1.database.prepare(
        "INSERT INTO visits (visit_id, site_id, started_at, pathname, country, perf_lcp_ms, perf_fcp_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "with-lcp",
        siteId,
        window.startMs + 60_000,
        "/with-lcp",
        "US",
        100,
        null,
      );
      insert.run(
        "no-lcp",
        siteId,
        window.startMs + 120_000,
        "/no-lcp",
        "CA",
        null,
        200,
      );
      const allCountries = await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
      );
      const focusedCountries = await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
        "lcp",
      );
      expect(
        focusedCountries.map((row) => ({
          country: row.country,
          views: row.views,
          lcp: row.metrics.lcp,
        })),
      ).toEqual(
        allCountries.map((row) => ({
          country: row.country,
          views: row.views,
          lcp: row.metrics.lcp,
        })),
      );
      expect(
        focusedCountries.find((row) => row.country === "CA")?.metrics.lcp,
      ).toEqual({
        avg: null,
        p50: null,
        p75: null,
        p95: null,
        samples: 0,
      });
      const allRoutes = await queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
      );
      const focusedRoutes = await queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        5,
        "lcp",
      );
      expect(
        focusedRoutes.map((row) => ({
          pathname: row.pathname,
          views: row.views,
          lcp: row.metrics.lcp,
        })),
      ).toEqual(
        allRoutes.map((row) => ({
          pathname: row.pathname,
          views: row.views,
          lcp: row.metrics.lcp,
        })),
      );
      expect(
        focusedRoutes.find((row) => row.pathname === "/no-lcp")?.metrics.lcp,
      ).toEqual({
        avg: null,
        p50: null,
        p75: null,
        p95: null,
        samples: 0,
      });
    } finally {
      d1.close();
    }
  });

  it("ranks top dimensions by all views before filtering metric samples", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    try {
      const insert = d1.database.prepare(
        "INSERT INTO visits (visit_id, site_id, started_at, pathname, country, perf_lcp_ms, perf_cls) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      // Most popular dimension has no metrics and must not be backfilled.
      for (let i = 0; i < 4; i++) {
        insert.run(
          "empty-" + i,
          siteId,
          window.startMs + i,
          "/empty",
          "US",
          null,
          null,
        );
      }
      insert.run("top-metric", siteId, window.startMs, "/mixed", "CA", null, 0);
      insert.run(
        "top-lcp",
        siteId,
        window.startMs + 1,
        "/mixed",
        "CA",
        120,
        null,
      );
      insert.run(
        "top-null",
        siteId,
        window.startMs + 2,
        "/mixed",
        "CA",
        null,
        null,
      );
      insert.run("outside-top", siteId, window.startMs, "/small", "GB", 999, 1);
      insert.run(
        "blank-country",
        siteId,
        window.startMs,
        "/small",
        " ",
        100,
        0.5,
      );
      for (const limit of [1, 2]) {
        const routes = await queryPerformanceRoutesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          limit,
        );
        const countries = await queryPerformanceCountriesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          limit,
        );
        expect(routes.map((r) => [r.pathname, r.views])).toEqual(
          limit === 1 ? [] : [["/mixed", 3]],
        );
        expect(countries.map((r) => [r.country, r.views])).toEqual(
          limit === 1 ? [] : [["CA", 3]],
        );
        if (limit === 2) {
          expect(routes[0]?.metrics.lcp).toEqual({
            avg: 120,
            p50: 120,
            p75: 120,
            p95: 120,
            samples: 1,
          });
          expect(countries[0]?.metrics.cls).toEqual({
            avg: 0,
            p50: 0,
            p75: 0,
            p95: 0,
            samples: 1,
          });
        }
      }
      await queryPerformanceRoutesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        "lcp",
      );
      await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        2,
        "lcp",
      );
      expect(
        d1.calls
          .slice(-2)
          .every(
            (call) => !call.sql.includes("top_metric_visits AS MATERIALIZED"),
          ),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("rejects invalid handlePerformance windows before querying D1", async () => {
    const { env, prepare } = createD1Env();

    const response = await handlePerformance(
      env,
      siteId,
      new URL("https://edge.test/performance?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("matches exact nearest ranks at percentile boundaries, ties and sparse samples", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    try {
      const insert = d1.database.prepare(
        "INSERT INTO visits (visit_id, site_id, started_at, pathname, country, perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms) VALUES (?, ?, ?, '/', 'US', ?, ?, ?, ?, ?)",
      );
      const ttfb = Array.from({ length: 20 }, (_, i) => i + 1);
      const fcp = Array.from({ length: 20 }, (_, i) => Math.floor(i / 4));
      const lcp = Array.from({ length: 20 }, (_, i) => (i < 19 ? i + 1 : null));
      const cls = Array.from({ length: 20 }, (_, i) => (i < 3 ? 0 : null));
      for (let i = 0; i < 20; i++) {
        insert.run(
          "rank-" + i,
          siteId,
          window.startMs + i,
          ttfb[i]!,
          fcp[i]!,
          lcp[i]!,
          cls[i]!,
          null,
        );
      }
      const summaries = await queryPerformanceSummariesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
      );
      expect(summaries).toEqual({
        ttfb: { avg: 10.5, p50: 10, p75: 15, p95: 19, samples: 20 },
        fcp: { avg: 2, p50: 2, p75: 3, p95: 4, samples: 20 },
        lcp: { avg: 10, p50: 10, p75: 15, p95: 19, samples: 19 },
        cls: { avg: 0, p50: 0, p75: 0, p95: 0, samples: 3 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      });
      const dashboard = await queryPerformanceDashboardFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      expect(dashboard.summaries).toEqual(summaries);
    } finally {
      d1.close();
    }
  });

  it("prunes entirely missing metrics before materializing summary and trend inputs", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    try {
      const insert = d1.database.prepare(
        "INSERT INTO visits (visit_id, site_id, started_at, pathname, country, perf_lcp_ms, perf_cls) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run("null", siteId, window.startMs, "/first", "US", null, null);
      insert.run("zero", siteId, window.startMs + 1, "/first", "US", null, 0);
      insert.run("lcp", siteId, window.startMs + 2, "/first", "US", 120, null);
      insert.run(
        "other-country",
        siteId,
        window.startMs + 3,
        "/first",
        "CA",
        900,
        0.5,
      );
      insert.run(
        "outside",
        siteId,
        window.endExclusiveMs,
        "/first",
        "US",
        999,
        1,
      );
      const filters = filterFixture({ country: "US" });
      const summary = await queryPerformanceSummariesFromD1(
        env,
        siteId,
        window,
        filters,
      );
      const trends = await queryAllPerformanceTrendsFromD1(
        env,
        siteId,
        window,
        "hour",
        filters,
      );
      expect(summary.lcp).toEqual({
        avg: 120,
        p50: 120,
        p75: 120,
        p95: 120,
        samples: 1,
      });
      expect(summary.cls).toEqual({
        avg: 0,
        p50: 0,
        p75: 0,
        p95: 0,
        samples: 1,
      });
      expect(summary.inp.samples).toBe(0);
      expect(trends.lcp).toEqual([
        {
          bucket: 0,
          timestampMs: Date.UTC(2026, 0, 2, 1),
          avg: 120,
          p50: 120,
          p75: 120,
          p95: 120,
          samples: 1,
        },
      ]);
      expect(trends.cls[0]?.samples).toBe(1);
      expect(trends.cls[0]?.p95).toBe(0);
      expect(trends.inp).toEqual([]);
      for (const call of d1.calls) {
        expect(call.sql).toMatch(
          /(?:filtered_visits|bucketed_visits) AS MATERIALIZED \([\s\S]*?\(perf_ttfb_ms IS NOT NULL OR perf_fcp_ms IS NOT NULL OR perf_lcp_ms IS NOT NULL OR perf_cls IS NOT NULL OR perf_inp_ms IS NOT NULL\)\s*\),/,
        );
      }
      // The dashboard still counts all eligible views, including null metrics.
      const dashboard = await queryPerformanceDashboardFromD1(
        env,
        siteId,
        window,
        "hour",
        filters,
        10,
      );
      expect(dashboard.summaries).toEqual(summary);
      expect(dashboard.trends).toEqual(trends);
      expect(dashboard.routes[0]?.views).toBe(3);
    } finally {
      d1.close();
    }
  });

  it("keeps dashboard percentiles and sample counts identical to independent readers", async () => {
    const { env, d1 } = createSqlitePerformanceEnv();
    try {
      const insert = d1.database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, started_at, pathname, country,
          perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < 39; index++) {
        insert.run(
          "dashboard-" + index,
          siteId,
          window.startMs + index * 120000,
          index % 3 === 0 ? "/second" : "/first",
          index % 2 === 0 ? "US" : "CA",
          index % 6 === 0 ? null : 10 * (index % 5),
          index % 3 === 0 ? null : index * 5,
          index % 4 === 0 ? null : index * 20,
          index % 2 === 0 ? 0 : 0.125,
          index % 7 === 0 ? 0 : null,
        );
      }
      insert.run(
        "null-metrics",
        siteId,
        window.startMs,
        "/first",
        "US",
        null,
        null,
        null,
        null,
        null,
      );
      // Empty countries must not appear in the country rollup, but their
      // observations still contribute to the page and global metrics.
      insert.run(
        "missing-country",
        siteId,
        window.startMs + 1,
        "/other",
        " ",
        10,
        null,
        100,
        0,
        null,
      );
      insert.run(
        "outside-window",
        siteId,
        window.endExclusiveMs,
        "/first",
        "US",
        1,
        1,
        1,
        1,
        1,
      );
      const dashboard = await queryPerformanceDashboardFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        1,
      );
      expect(d1.calls).toHaveLength(1);
      const sql = d1.calls[0]?.sql ?? "";
      expect(sql).not.toContain("_thresholds AS");
      expect(sql.match(/CUME_DIST\(\) OVER/g)).toHaveLength(4);
      expect(sql).not.toContain("JOIN summary_ordered_values");
      expect(sql).toContain(
        "WHERE metric_visits.pathname IN (SELECT pathname FROM path_views)",
      );
      expect(sql).toContain("WHERE metric_visits.country != ''");
      expect(sql).toContain(
        "JOIN path_views ON path_views.pathname = route_rows.pathname",
      );
      expect(sql).toContain(
        "JOIN country_views ON country_views.country = country_rows.country",
      );
      expect(sql).not.toContain(
        "JOIN path_views ON path_views.pathname = ordered.pathname",
      );
      expect(sql).not.toContain(
        "JOIN country_views ON country_views.country = ordered.country",
      );
      expect(dashboard.summaries).toEqual(
        await queryPerformanceSummariesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
        ),
      );
      expect(dashboard.trends).toEqual(
        await queryAllPerformanceTrendsFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
        ),
      );
      expect(dashboard.routes).toEqual(
        await queryPerformanceRoutesFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          1,
        ),
      );
      const expectedCountries = await queryPerformanceCountriesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        10,
      );
      expect(dashboard.countries).toHaveLength(expectedCountries.length);
      expect(
        new Map(dashboard.countries.map((row) => [row.country, row])),
      ).toEqual(new Map(expectedCountries.map((row) => [row.country, row])));
      expect(dashboard.summaries.cls.p50).toBe(0);
      expect(dashboard.summaries.inp.p95).toBe(0);
      expect(dashboard.routes[0]?.views).toBe(27);
    } finally {
      d1.close();
    }
  });

  it("serves the performance dashboard with one shared D1 statement", async () => {
    const { env, prepare } = createD1Env([
      [
        {
          rowType: "trend",
          metric: "lcp",
          bucket: 0,
          samples: 2,
          avgValue: 150,
          p50: 100,
          p75: 200,
          p95: 200,
        },
      ],
    ]);

    const response = await handlePerformance(
      env,
      siteId,
      new URL(
        "https://edge.test/performance?from=1767317400000&to=1767323100000&interval=hour",
      ),
    );

    expect(response.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      trends: {
        lcp: [{ bucket: 0, avg: 150, p75: 200, samples: 2 }],
      },
    });
  });
});
