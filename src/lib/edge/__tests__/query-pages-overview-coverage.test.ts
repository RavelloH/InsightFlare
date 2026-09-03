import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { handleFilterValuesContract } from "@/lib/edge/analytics/composition/protocol/filter-values-contract-adapter";
import {
  handleOverviewContract as handleOverview,
  handleTrendContract as handleTrend,
} from "@/lib/edge/analytics/composition/protocol/overview-contract-adapter";
import { handleOverviewGeoPointsContract as handleOverviewGeoPoints } from "@/lib/edge/analytics/composition/protocol/overview-extras-contract-adapter";
import { handleOverviewTabContract } from "@/lib/edge/analytics/composition/protocol/overview-tabs-contract-adapter";
import {
  handlePagesContract as handlePages,
  handlePagesDashboardContract as handlePagesDashboard,
  handleReferrersContract as handleReferrers,
} from "@/lib/edge/analytics/composition/protocol/pages-contract-adapter";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  mapDimensionRows,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import {
  queryLatestSiteActivity,
  queryOverviewFromD1,
  queryTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  queryDimensionAggregate,
  queryPageCardMetricsFromD1,
  queryPageCardTitlesFromD1,
  queryPageCardTrendFromD1,
  queryTopPagesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";
import { installVisitSiteIdentityFixture } from "./site-identity-fixture";

type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const siteId = "site-pages";
const baseMs = Date.UTC(2026, 0, 2, 1);
const window: QueryWindow = {
  startMs: baseMs,
  endExclusiveMs: baseMs + 2 * 60 * 60 * 1000,
  nowMs: baseMs + 3 * 60 * 60 * 1000,
  timeZone: "UTC",
};

function createD1Env(
  resultSets: D1Row[][],
  rowsRead?: number,
): {
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
        return {
          results: pendingResults.shift() ?? [],
          ...(rowsRead === undefined ? {} : { meta: { rows_read: rowsRead } }),
        };
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

function createScopedOverviewSqliteEnv(): {
  env: Env;
  database: DatabaseSync;
  close: () => void;
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0008_rebuild_analytics.sql",
    "migrations/0013_add_visit_performance_metrics.sql",
    "migrations/0017_structured_custom_events.sql",
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  installVisitSiteIdentityFixture(database);
  database.exec(`
    ALTER TABLE custom_event_names ADD COLUMN site_pk INTEGER;
    ALTER TABLE custom_events ADD COLUMN site_pk INTEGER;

    CREATE TRIGGER test_custom_event_names_site_pk
    AFTER INSERT ON custom_event_names
    WHEN NEW.site_pk IS NULL
    BEGIN
      UPDATE custom_event_names
      SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER test_custom_events_site_pk
    AFTER INSERT ON custom_events
    WHEN NEW.site_pk IS NULL
    BEGIN
      UPDATE custom_events
      SET site_pk = (SELECT site_pk FROM site_identities WHERE site_id = NEW.site_id)
      WHERE event_pk = NEW.event_pk;
    END;
  `);
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: QueryBinding[]) => ({
          all: async () => ({
            results: database.prepare(sql).all(...bindings) as D1Row[],
          }),
        }),
      }),
    },
  } as unknown as Env;
  return { env, database, close: () => database.close() };
}

function visitBindings(targetWindow = window): QueryBinding[] {
  return [siteId, targetWindow.startMs, targetWindow.endExclusiveMs];
}

function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

describe("edge pages D1 queries", () => {
  it("queries top pages with details, filters, numeric mapping, and limit binding", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: "/pricing",
          queryValue: "plan=pro",
          hashValue: "faq",
          views: "12",
          sessions: "5",
        },
      ],
    ]);

    await expect(
      queryTopPagesFromD1(
        env,
        siteId,
        window,
        15,
        true,
        filterFixture({
          country: "US",
          hostname: "Example.COM",
          path: "/pricing",
        }),
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        query: "plan=pro",
        hash: "faq",
        views: 12,
        sessions: 5,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("query_string AS queryValue");
    expect(calls[0].sql).toContain("hash_fragment AS hashValue");
    expect(calls[0].sql).toContain("GROUP BY pathname, queryValue, hashValue");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "us",
      "example.com",
      "/pricing",
      15,
    ]);
  });

  it("omits query and hash details when details are disabled", async () => {
    const { env, calls } = createD1Env([[{ pathname: "/docs", views: 3 }]]);

    await expect(
      queryTopPagesFromD1(env, siteId, window, 5, false, EMPTY_FILTER_DOCUMENT),
    ).resolves.toEqual([
      { pathname: "/docs", query: "", hash: "", views: 3, sessions: 0 },
    ]);

    expect(calls[0].sql).toContain("'' AS queryValue");
    expect(calls[0].sql).toContain("'' AS hashValue");
    expect(calls[0].bindings).toEqual([...visitBindings(), 5]);
  });

  it("normalizes sparse top page rows", async () => {
    const { env } = createD1Env([
      [
        {
          pathname: null,
          queryValue: undefined,
          hashValue: null,
          views: undefined,
          sessions: null,
        },
      ],
    ]);

    await expect(
      queryTopPagesFromD1(env, siteId, window, 1, true, EMPTY_FILTER_DOCUMENT),
    ).resolves.toEqual([
      { pathname: "", query: "", hash: "", views: 0, sessions: 0 },
    ]);
  });

  it("dedupes page card path filters, applies pagination, and maps aggregate rows", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: "/pricing",
          views: "8",
          sessions: "4",
          visitors: "3",
          bounces: "1",
          totalDuration: "120000",
        },
      ],
    ]);

    await expect(
      queryPageCardMetricsFromD1(
        env,
        siteId,
        window,
        filterFixture({ browser: "Chrome" }),
        {
          pathnames: [" /pricing ", "/pricing", "", "/docs"],
          limit: 10,
          offset: -5,
        },
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        views: 8,
        sessions: 4,
        visitors: 3,
        bounces: 1,
        totalDuration: 120000,
        durationViews: 0,
      },
    ]);

    expect(calls[0].sql).toContain("path_bounce_rollup AS");
    expect(calls[0].sql).toContain("TRIM(COALESCE(pathname, '')) IN (?, ?)");
    expect(calls[0].sql).toContain("LIMIT ? OFFSET ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "Chrome",
      "/pricing",
      "/docs",
      10,
      0,
    ]);
  });

  it("maps sparse page card rows without pagination options", async () => {
    const { env, calls } = createD1Env([
      [
        {
          pathname: null,
          views: undefined,
          sessions: null,
          visitors: undefined,
          bounces: null,
          totalDuration: undefined,
          durationViews: null,
        },
      ],
    ]);

    await expect(
      queryPageCardMetricsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        undefined,
      ),
    ).resolves.toEqual([
      {
        pathname: "",
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDuration: 0,
        durationViews: 0,
      },
    ]);
    expect(calls[0].sql).not.toContain("LIMIT ? OFFSET ?");
    expect(calls[0].bindings).toEqual(visitBindings());
  });

  it("materializes page-card visits once while preserving path-level bounces", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
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
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?)
    `);

    try {
      insert.run(
        "root-first",
        siteId,
        "visitor-1",
        "session-1",
        baseMs,
        baseMs,
        "/",
        100,
      );
      insert.run(
        "root-last",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 1,
        baseMs + 1,
        "/",
        200,
      );
      insert.run(
        "pricing-first",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 2,
        baseMs + 2,
        "/pricing",
        50,
      );
      insert.run(
        "pricing-second",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 3,
        baseMs + 3,
        "/pricing",
        null,
      );
      insert.run(
        "outside-window",
        siteId,
        "visitor-3",
        "session-4",
        window.endExclusiveMs,
        window.endExclusiveMs,
        "/pricing",
        999,
      );

      await expect(
        queryPageCardMetricsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          undefined,
        ),
      ).resolves.toEqual([
        {
          pathname: "/pricing",
          views: 2,
          sessions: 2,
          visitors: 2,
          bounces: 2,
          totalDuration: 50,
          durationViews: 0,
        },
        {
          pathname: "/",
          views: 2,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDuration: 300,
          durationViews: 0,
        },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
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

  it("returns empty title and trend queries without touching D1 when pathnames are empty", async () => {
    const { env, prepare } = createD1Env([]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        ["", "  "],
        3,
      ),
    ).resolves.toEqual([]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        [],
      ),
    ).resolves.toEqual([]);

    expect(prepare).not.toHaveBeenCalled();
  });

  it("maps page card titles and hourly trend buckets with path filters", async () => {
    const { env, calls } = createD1Env([
      [
        { pathname: "/pricing", title: "Pricing", views: "6" },
        { pathname: "/pricing", title: "Plans", views: 2 },
      ],
      [
        { pathname: "/pricing", bucket: "0", views: "3", visitors: "2" },
        { pathname: "/pricing", bucket: 1, views: 5, visitors: 4 },
      ],
    ]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        filterFixture({ clientDeviceType: "desktop" }),
        ["/pricing"],
        2,
      ),
    ).resolves.toEqual([
      { pathname: "/pricing", title: "Pricing", views: 6 },
      { pathname: "/pricing", title: "Plans", views: 2 },
    ]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        filterFixture({ clientDeviceType: "desktop" }),
        ["/pricing"],
      ),
    ).resolves.toEqual([
      {
        pathname: "/pricing",
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 3,
        visitors: 2,
      },
      {
        pathname: "/pricing",
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        views: 5,
        visitors: 4,
      },
    ]);

    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "desktop",
      "/pricing",
      2,
    ]);
    expect(calls[1].sql).toContain("CASE WHEN startedAt >=");
    expect(calls[1].bindings).toEqual([
      ...visitBindings(),
      "desktop",
      "/pricing",
    ]);
  });

  it("normalizes sparse page card title and trend rows", async () => {
    const { env } = createD1Env([
      [
        {
          pathname: null,
          title: undefined,
          views: null,
        },
      ],
      [
        {
          pathname: null,
          bucket: null,
          views: undefined,
          visitors: null,
        },
      ],
    ]);

    await expect(
      queryPageCardTitlesFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        ["/pricing"],
        3,
      ),
    ).resolves.toEqual([{ pathname: "", title: "", views: 0 }]);
    await expect(
      queryPageCardTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        ["/pricing"],
      ),
    ).resolves.toEqual([
      {
        pathname: "",
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 0,
        visitors: 0,
      },
    ]);
  });

  it("uses final scoped dataset bindings for page card queries", async () => {
    const { env, calls } = createD1Env([
      [{ pathname: "/pricing", title: "Pricing", views: 3 }],
      [{ pathname: "/pricing", bucket: 0, views: 2, visitors: 1 }],
    ]);
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext("site-pages", "private-dashboard"),
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        "UTC",
        window.nowMs,
      ),
      filters: filterFixture({ path: "/pricing" }),
      scopePreference: "visitor",
    } as never);

    await queryPageCardTitlesFromD1(
      env,
      siteId,
      window,
      prepared.filters!,
      ["/pricing"],
      3,
    );
    await queryPageCardTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      prepared.filters!,
      ["/pricing"],
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.bindings.length).toBeGreaterThan(3);
    expect(calls[1]?.bindings.length).toBeGreaterThan(3);
    expect(calls[0]?.sql).toContain("scope_final_visits");
    expect(calls[1]?.sql).toContain("scope_final_visits");
  });
});

describe("edge pages handlers", () => {
  it("maps pages and all tabs from D1 when includeTabs is enabled", async () => {
    const { env, calls } = createD1Env([
      [{ pathname: "/home", queryValue: "x=1", hashValue: "", views: 7 }],
      [
        {
          cardType: "path",
          value: "/home",
          views: 2,
          sessions: 2,
          visitors: 2,
        },
        {
          cardType: "path",
          value: "/pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "title",
          value: "Home",
          views: 2,
          sessions: 2,
          visitors: 2,
        },
        {
          cardType: "title",
          value: "Pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "hostname",
          value: "example.com",
          views: 3,
          sessions: 2,
          visitors: 2,
        },
        {
          cardType: "entry",
          value: "/home",
          views: 2,
          sessions: 2,
          visitors: 2,
        },
        {
          cardType: "exit",
          value: "/home",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "exit",
          value: "/pricing",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    ]);

    const response = await handlePages(
      env,
      siteId,
      url("/pages", {
        from: window.startMs,
        to: window.endExclusiveMs,
        details: true,
        "filter[geo.country]": "US",
        limit: 5,
      }),
      true,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          pathname: "/home",
          query: "x=1",
          hash: "",
          views: 7,
          sessions: 0,
        },
      ],
      tabs: {
        path: [
          { label: "/home", views: 2, sessions: 2, visitors: 2 },
          { label: "/pricing", views: 1, sessions: 1, visitors: 1 },
        ],
        title: [
          { label: "Home", views: 2, sessions: 2, visitors: 2 },
          { label: "Pricing", views: 1, sessions: 1, visitors: 1 },
        ],
        hostname: [
          { label: "example.com", views: 3, sessions: 2, visitors: 2 },
        ],
        entry: [{ label: "/home", views: 2, sessions: 2, visitors: 2 }],
        exit: [
          { label: "/home", views: 1, sessions: 1, visitors: 1 },
          { label: "/pricing", views: 1, sessions: 1, visitors: 1 },
        ],
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].bindings.slice(-2)).toEqual(["us", 5]);
    expect(calls[1].bindings.slice(-2)).toEqual(["us", 5]);
    expect(calls[1].sql).toContain("ranked_cards AS");
  });

  it("maps referrer handler rows with full URL mode and filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          referrer: "https://news.example/post",
          views: "6",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const response = await handleReferrers(
      env,
      siteId,
      url("/referrers", {
        from: window.startMs,
        to: window.endExclusiveMs,
        fullUrl: true,
        "filter[client.browser]": "Chrome",
        limit: 7,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          referrer: "https://news.example/post",
          views: 6,
          sessions: 3,
        },
      ],
    });
    expect(calls[0].sql).toContain("COALESCE(referrer_url, '') AS referrer");
    expect(calls[0].bindings.slice(-2)).toEqual(["Chrome", 7]);
  });

  it("maps dimension aggregate rows and drops geo filters before querying", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "Chrome",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filterFixture({ device: "desktop" }),
      4,
      "browser",
    );

    expect(mapDimensionRows(rows)).toEqual([
      {
        value: "Chrome",
        label: "Chrome",
        views: 5,
        sessions: 3,
        visitors: 2,
      },
    ]);
    expect(calls[0].sql).toContain("COALESCE(browser, '') AS value");
    expect(calls[0].bindings).toEqual([...visitBindings(), "desktop", 4]);
  });

  it("returns an empty dashboard page without loading previous, titles, or trend rows", async () => {
    const { env, calls } = createD1Env([[]]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        page: 2,
        pageSize: 4,
        interval: "hour",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      interval: "hour",
      data: [],
      meta: {
        page: 2,
        pageSize: 4,
        returned: 0,
        hasMore: false,
        nextPage: null,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].bindings.slice(-2)).toEqual([5, 4]);
  });

  it("compiles URL visitor scope before invoking the page dashboard provider", async () => {
    const { env, calls } = createD1Env([[]]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        scope: "visitor",
        "filter[page.path]": "/pricing",
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("scope_final_visits");
    expect(calls[0].bindings.length).toBeGreaterThan(4);
  });

  it("rejects deep dashboard pages before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        page: 10_000,
        pageSize: 24,
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("maps dashboard cards, titles, trends, previous changes, and hasMore pagination", async () => {
    const currentRows = [
      {
        pathname: "/pricing",
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 1,
        totalDuration: 50000,
      },
      {
        pathname: "/docs",
        views: 4,
        sessions: 2,
        visitors: 2,
        bounces: 2,
        totalDuration: 20000,
      },
      {
        pathname: "/more",
        views: 1,
        sessions: 1,
        visitors: 1,
        bounces: 1,
        totalDuration: 1000,
      },
    ];
    const { env, calls } = createD1Env([
      currentRows,
      [
        {
          pathname: "/pricing",
          views: 5,
          sessions: 5,
          visitors: 2,
          bounces: 2,
          totalDuration: 25000,
        },
      ],
      [
        {
          rowKind: "title",
          pathname: "/pricing",
          title: " Pricing ",
          views: 8,
        },
        {
          rowKind: "title",
          pathname: "/pricing",
          title: "Pricing",
          views: 2,
        },
        { rowKind: "title", pathname: "/docs", title: "Docs", views: 4 },
        {
          rowKind: "trend",
          pathname: "/pricing",
          bucket: 0,
          views: 6,
          visitors: 3,
        },
        {
          rowKind: "trend",
          pathname: "/docs",
          bucket: 1,
          views: 4,
          visitors: 2,
        },
      ],
    ]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.startMs,
        to: window.endExclusiveMs,
        page: 1,
        pageSize: 2,
        interval: "hour",
      }),
    );
    const payload = await response.json();

    expect(payload).toMatchObject({
      ok: true,
      interval: "hour",
      meta: {
        page: 1,
        pageSize: 2,
        returned: 2,
        hasMore: true,
        nextPage: 2,
      },
      data: [
        {
          pathname: "/pricing",
          titles: ["Pricing"],
          metrics: {
            views: 10,
            visitors: 4,
            sessions: 5,
            bounceRate: 0.2,
            pagesPerSession: 2,
            avgDurationMs: 10000,
          },
          changeRates: {
            views: 100,
            visitors: 100,
            sessions: 0,
            bounceRate: -50,
            pagesPerSession: 100,
            avgDurationMs: 100,
          },
          trend: [
            {
              timestampMs: Date.UTC(2026, 0, 2, 1),
              views: 6,
              visitors: 3,
            },
          ],
        },
        {
          pathname: "/docs",
          titles: ["Docs"],
          metrics: {
            views: 4,
            visitors: 2,
            sessions: 2,
            bounceRate: 1,
            pagesPerSession: 2,
            avgDurationMs: 10000,
          },
          changeRates: {
            views: null,
            visitors: null,
            sessions: null,
            bounceRate: null,
            pagesPerSession: null,
            avgDurationMs: null,
          },
          trend: [
            {
              timestampMs: Date.UTC(2026, 0, 2, 2),
              views: 4,
              visitors: 2,
            },
          ],
        },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].bindings.slice(-2)).toEqual([3, 0]);
    expect(calls[1].bindings.slice(-2)).toEqual(["/pricing", "/docs"]);
    expect(calls[2].bindings.slice(-3)).toEqual(["/pricing", "/docs", 3]);
    expect(calls[2].sql).toContain("filtered_visits AS MATERIALIZED");
  });
});

describe("edge overview D1 queries and handlers", () => {
  it("reads the latest filtered site activity without turning an absent value into epoch", async () => {
    const { env, calls } = createD1Env([
      [{ lastActivityAt: 123 }],
      [{ lastActivityAt: null }],
      [{ lastActivityAt: "not-a-time" }],
    ]);
    const filters = filterFixture({ country: "US" });

    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBe(123);
    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBeNull();
    await expect(
      queryLatestSiteActivity(env, siteId, window, filters),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[0]?.sql).toContain("MAX(last_activity_at)");
    expect(calls[0]?.bindings).toEqual([...visitBindings(), "us"]);
  });

  it("maps overview aggregate fallback values and applies filters", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryOverviewFromD1(
        env,
        siteId,
        window,
        filterFixture({
          country: "US",
          clientBrowser: "Chrome",
        }),
      ),
    ).resolves.toEqual({
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    });

    expect(calls[0].sql).toContain("session_rollup AS");
    expect(calls[0].bindings).toEqual([...visitBindings(), "Chrome", "us"]);
  });

  it("materializes filtered overview visits once while preserving aggregates", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
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
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, country, browser, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?, ?)
    `);

    try {
      insert.run(
        "first-session-first-visit",
        siteId,
        "visitor-1",
        "session-1",
        baseMs,
        baseMs,
        "/",
        "US",
        "Chrome",
        100,
      );
      insert.run(
        "first-session-second-visit",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 1,
        baseMs + 1,
        "/docs",
        "US",
        "Chrome",
        null,
      );
      insert.run(
        "second-session-visit",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 2,
        baseMs + 2,
        "/pricing",
        "US",
        "Chrome",
        50,
      );
      insert.run(
        "excluded-country",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 3,
        baseMs + 3,
        "/",
        "CA",
        "Chrome",
        999,
      );

      await expect(
        queryOverviewFromD1(
          env,
          siteId,
          window,
          filterFixture({ path: "/docs" }),
        ),
      ).resolves.toEqual({
        views: 2,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDuration: 100,
        durationViews: 1,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
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

  it("counts event-only Session entities in scoped overview and trend", async () => {
    const sqlite = createScopedOverviewSqliteEnv();
    const eventAt = baseMs + 15 * 60 * 1000;
    try {
      sqlite.database
        .prepare(
          `
          INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, status, started_at,
            last_activity_at, pathname, hostname
          ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
        `,
        )
        .run(
          "event-only-visit",
          siteId,
          "event-only-visitor",
          "event-only-session",
          baseMs - 60 * 60 * 1000,
          baseMs - 60 * 60 * 1000,
          "/event-only",
        );
      sqlite.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name, last_seen_at) VALUES (?, ?, ?, ?)",
        )
        .run(1, siteId, "signup", eventAt);
      sqlite.database
        .prepare(
          `
          INSERT INTO custom_events (
            event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          1,
          "event-only-event",
          siteId,
          "event-only-visit",
          1,
          eventAt,
          eventAt,
          0,
          0,
          0,
        );

      const prepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          window.timeZone,
          window.nowMs,
        ),
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "event.name" as never },
            operator: "eq",
            value: "signup",
          },
        },
        scopePreference: "session",
      } as never);
      const filters = prepared.filters!;

      await expect(
        queryOverviewFromD1(sqlite.env, siteId, window, filters),
      ).resolves.toMatchObject({
        views: 0,
        sessions: 1,
        visitors: 1,
      });
      await expect(
        queryTrendFromD1(sqlite.env, siteId, window, "hour", filters),
      ).resolves.toEqual([
        expect.objectContaining({
          bucket: 0,
          views: 0,
          sessions: 1,
          visitors: 1,
          bounces: 0,
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("filters overview visits by each session's entry path", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
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
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?)
    `);

    try {
      insert.run(
        "matching-entry",
        siteId,
        "visitor-1",
        "matching-session",
        baseMs,
        baseMs,
        "/landing",
        20,
      );
      insert.run(
        "matching-follow-up",
        siteId,
        "visitor-1",
        "matching-session",
        baseMs + 1,
        baseMs + 1,
        "/pricing",
        30,
      );
      insert.run(
        "different-entry",
        siteId,
        "visitor-2",
        "other-session",
        baseMs + 2,
        baseMs + 2,
        "/docs",
        99,
      );
      insert.run(
        "empty-session",
        siteId,
        "visitor-3",
        "",
        baseMs + 3,
        baseMs + 3,
        "/landing",
        999,
      );

      await expect(
        queryOverviewFromD1(
          env,
          siteId,
          window,
          filterFixture({
            entry: "/landing",
            exit: "/pricing",
          }),
        ),
      ).resolves.toEqual({
        views: 2,
        sessions: 1,
        visitors: 1,
        bounces: 0,
        totalDuration: 50,
        durationViews: 2,
      });

      expect(calls).toHaveLength(1);
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.some((row) => row.detail.includes("CORRELATED SCALAR SUBQUERY")),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("uses filtered visits to select retention visitors, then counts their later visits", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...bindings: QueryBinding[]) => ({
            all: async () => ({
              results: database.prepare(sql).all(...bindings) as D1Row[],
            }),
          }),
        }),
      } as unknown as D1Database,
    } as Env;
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test')
    `);

    try {
      insert.run(
        "retention-match",
        siteId,
        "visitor-match",
        "retention-session",
        baseMs + 100,
        baseMs + 100,
        "/match",
      );
      insert.run(
        "retention-return",
        siteId,
        "visitor-match",
        "retention-session",
        baseMs + 60 * 60 * 1000 + 100,
        baseMs + 60 * 60 * 1000 + 100,
        "/return",
      );
      insert.run(
        "retention-other",
        siteId,
        "visitor-other",
        "other-session",
        baseMs + 100,
        baseMs + 100,
        "/other",
      );

      await expect(
        queryRetentionFromD1(
          env,
          siteId,
          window,
          filterFixture({ path: "/match" }),
          "hour",
        ),
      ).resolves.toEqual({
        granularity: "hour",
        cohorts: [
          {
            bucket: baseMs,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
            ],
          },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("maps trend rows, bucket timestamps, and filter bindings", async () => {
    const filters: FilterDocument = filterFixture({
      sourceDomain: "Ref.Example",
      clientDeviceType: "mobile",
    });
    const { env, calls } = createD1Env([
      [
        {
          bucket: "0",
          views: "3",
          visitors: "2",
          sessions: "2",
          bounces: "1",
          totalDuration: "6000",
          durationViews: "3",
        },
        {
          bucket: 1,
          views: 4,
          visitors: 3,
          sessions: 2,
          bounces: 0,
          totalDuration: 8000,
          durationViews: 4,
        },
      ],
    ]);

    await expect(
      queryTrendFromD1(env, siteId, window, "hour", filters),
    ).resolves.toEqual([
      {
        bucket: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        views: 3,
        visitors: 2,
        sessions: 2,
        bounces: 1,
        totalDuration: 6000,
        durationViews: 3,
      },
      {
        bucket: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        views: 4,
        visitors: 3,
        sessions: 2,
        bounces: 0,
        totalDuration: 8000,
        durationViews: 4,
      },
    ]);

    expect(calls[0].sql).toContain("visit_bucket_rollup AS");
    expect(calls[0].sql).toContain("session_bucket_rollup AS");
    expect(calls[0].sql).toContain("CASE WHEN started_at >=");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(),
      "mobile",
      "ref.example",
    ]);
  });

  it("materializes filtered trend visits once while preserving bucket metrics", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0008_rebuild_analytics.sql",
      "migrations/0013_add_visit_performance_metrics.sql",
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    installVisitSiteIdentityFixture(database);
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
    const insert = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, country, duration_ms
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', ?, ?)
    `);

    try {
      insert.run(
        "first-hour",
        siteId,
        "visitor-1",
        "session-1",
        baseMs + 100,
        baseMs + 100,
        "/",
        "US",
        100,
      );
      insert.run(
        "second-hour-first",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 60 * 60 * 1000 + 100,
        baseMs + 60 * 60 * 1000 + 100,
        "/docs",
        "US",
        200,
      );
      insert.run(
        "second-hour-last",
        siteId,
        "visitor-1",
        "session-2",
        baseMs + 60 * 60 * 1000 + 200,
        baseMs + 60 * 60 * 1000 + 200,
        "/pricing",
        "US",
        300,
      );
      insert.run(
        "excluded-country",
        siteId,
        "visitor-2",
        "session-3",
        baseMs + 300,
        baseMs + 300,
        "/",
        "CA",
        999,
      );

      await expect(
        queryTrendFromD1(
          env,
          siteId,
          window,
          "hour",
          filterFixture({ path: "/docs" }),
        ),
      ).resolves.toEqual([
        {
          bucket: 1,
          timestampMs: baseMs + 60 * 60 * 1000,
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDuration: 500,
          durationViews: 2,
        },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("filtered_visits AS MATERIALIZED");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${calls[0]?.sql ?? "SELECT 1"}`)
        .all(...(calls[0]?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SEARCH visits USING INDEX")),
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

  it("returns overview metrics with previous change rates and detail trend mapping", async () => {
    const { env, calls } = createD1Env([
      [
        {
          views: 10,
          sessions: 5,
          visitors: 4,
          bounces: 1,
          totalDuration: 50000,
          durationViews: 10,
        },
      ],
      [
        {
          views: 5,
          sessions: 5,
          visitors: 2,
          bounces: 2,
          totalDuration: 25000,
          durationViews: 5,
        },
      ],
      [
        {
          bucket: 0,
          views: 6,
          visitors: 3,
          sessions: 3,
          bounces: 1,
          totalDuration: 30000,
          durationViews: 6,
        },
      ],
    ]);

    const response = await handleOverview(
      env,
      siteId,
      url("/overview", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "hour",
        includeChange: true,
        includeDetail: true,
        "filter[page.path]": "/pricing",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 1,
        totalDurationMs: 50000,
        avgDurationMs: 10000,
        bounceRate: 0.2,
        approximateVisitors: false,
      },
      previousData: {
        views: 5,
        sessions: 5,
        visitors: 2,
        bounces: 2,
        totalDurationMs: 25000,
        avgDurationMs: 5000,
        bounceRate: 0.4,
        approximateVisitors: false,
      },
      changeRates: {
        views: 100,
        sessions: 0,
        visitors: 100,
        bounces: -50,
        bounceRate: -50,
        avgDurationMs: 100,
      },
      detail: {
        interval: "hour",
        data: [
          {
            bucket: 0,
            timestampMs: Date.UTC(2026, 0, 2, 1),
            views: 6,
            visitors: 3,
            sessions: 3,
            bounces: 1,
            totalDurationMs: 30000,
            avgDurationMs: 10000,
            source: "detail",
          },
        ],
      },
    });
    expect(response.headers.get("x-insightflare-data-source")).toBe("raw");
    expect(response.headers.get("x-insightflare-d1-rows-read")).toBe(
      "unavailable",
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([
      "/pricing",
      "/pricing",
      "/pricing",
    ]);
  });

  it("maps trend handler rows without optional overview change payload", async () => {
    const { env, calls } = createD1Env([
      [
        {
          bucket: 0,
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDuration: 3000,
          durationViews: 1,
        },
      ],
    ]);

    const response = await handleTrend(
      env,
      siteId,
      url("/trend", {
        from: window.startMs,
        to: window.endExclusiveMs,
        interval: "hour",
        "filter[referrer.domain]": "Ref.Example",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      interval: "hour",
      data: [
        {
          bucket: 0,
          timestampMs: Date.UTC(2026, 0, 2, 1),
          views: 2,
          visitors: 1,
          sessions: 1,
          bounces: 0,
          totalDurationMs: 3000,
          avgDurationMs: 3000,
          source: "detail",
        },
      ],
    });
    expect(calls[0].bindings.at(-1)).toBe("ref.example");
  });

  it("maps overview page, source, client, and geo tab handlers", async () => {
    const { env, calls } = createD1Env(
      [
        [
          {
            value: "/home",
            views: "1",
            sessions: "1",
            visitors: "1",
          },
        ],
        [
          {
            referrer: "",
            views: "4",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            channel: "organic_search",
            views: "3",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            value: "1440x900",
            views: "2",
            sessions: "2",
            visitors: "2",
          },
        ],
        [
          {
            value: "US",
            views: "1",
            sessions: "1",
            visitors: "1",
          },
        ],
      ],
      37,
    );

    const pageTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/page-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 2,
      }),
      "page.path",
    );
    const sourceTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/source-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "source.domain",
    );
    const sourceChannelTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/source-channel-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "source.channel",
    );
    const clientTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/client-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 3,
      }),
      "client.screenSize",
    );
    const geoTab = await handleOverviewTabContract(
      env,
      siteId,
      url("/overview/geo-tab", {
        from: window.startMs,
        to: window.endExclusiveMs,
        geo: "US::CA::California",
        limit: 3,
      }),
      "geo.country",
    );

    await expect(pageTab.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "/home", views: 1, sessions: 1, visitors: 1 }],
    });
    await expect(sourceTab.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "", views: 4, sessions: 2, visitors: 2 }],
    });
    await expect(sourceChannelTab.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          label: "organic_search",
          views: 3,
          sessions: 2,
          visitors: 2,
        },
      ],
    });
    await expect(clientTab.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "1440x900", views: 2, sessions: 2, visitors: 0 }],
    });
    await expect(geoTab.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          value: "US",
          label: "US",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    });
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([2, 3, 3, 3, 3]);
    expect(calls[2].sql).toContain("channel_rollup AS");
    for (const call of [calls[0], calls[3], calls[4]]) {
      expect(call.sql).toContain("GROUP BY value");
      expect(call.sql).toContain("WHERE TRIM(value) != ''");
    }
  });

  it("maps filter option branches across page, source, client, geo, and scalar keys", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "US",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
      [
        {
          cardType: "path",
          value: "/home",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [
        {
          referrer: "",
          views: "4",
          sessions: "2",
          visitors: "1",
        },
      ],
      [
        {
          cardType: "screenSize",
          value: "390x844",
          views: 1,
          sessions: 1,
        },
      ],
      [
        {
          cardType: "country",
          value: "US",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "region",
          value: "US::CA::California",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
        {
          cardType: "city",
          value: "US::CA::California::San Francisco",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
      [],
      [],
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

    const scalar = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.country",
        "filter[geo.country]": "US",
        "filter[client.browser]": "Chrome",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const page = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "page.path",
        "filter[page.path]": "/home",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const source = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "referrer.domain",
        "filter[referrer.domain]": "__direct__",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const client = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.screenSize",
        "filter[client.screenSize]": "390x844",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const geo = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.region",
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const geoOrganization = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "geo.organization",
        "filter[geo.organization]": "Example ISP",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );

    const responses = [
      [scalar, "geo.country"],
      [page, "page.path"],
      [source, "referrer.domain"],
      [client, "client.screenSize"],
      [geo, "geo.region"],
      [geoOrganization, "geo.organization"],
    ] as const;
    for (const [response, field] of responses) {
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        field,
        data: expect.any(Array),
      });
    }
    expect(calls[0]?.bindings.at(-1)).toBe(4);
    expect(calls.every((call) => call.bindings.at(-1) === 4)).toBe(true);
    expect(calls.flatMap((call) => call.bindings)).toEqual(
      expect.arrayContaining(["us"]),
    );
  });

  it("maps device and browser filter option scalar branches", async () => {
    const { env, calls } = createD1Env([
      [
        {
          value: "desktop",
          views: "6",
          sessions: "4",
          visitors: "3",
        },
      ],
      [
        {
          value: "Chrome",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const device = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.deviceType",
        "filter[client.deviceType]": "desktop",
        "filter[client.browser]": "Chrome",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );
    const browser = await handleFilterValuesContract(
      env,
      siteId,
      url("/filter-values", {
        filterKey: "client.browser",
        "filter[client.browser]": "Chrome",
        "filter[geo.country]": "US",
        from: window.startMs,
        to: window.endExclusiveMs,
        limit: 4,
      }),
    );

    await expect(device.json()).resolves.toEqual({
      ok: true,
      field: "client.deviceType",
      data: [{ value: "desktop", label: "desktop", occurrences: 6 }],
    });
    await expect(browser.json()).resolves.toEqual({
      ok: true,
      field: "client.browser",
      data: [{ value: "Chrome", label: "Chrome", occurrences: 5 }],
    });
    expect(calls[0].sql).toContain("TRIM(COALESCE(device_type, ''))");
    expect(calls[1].sql).toContain("TRIM(COALESCE(browser, ''))");
    expect(calls.map((call) => call.bindings.at(-1))).toEqual([4, 4]);
  });

  it("maps overview geo points with and without applying geo filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          latitude: "37.7",
          longitude: "-122.4",
          timestampMs: String(window.startMs),
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
        },
      ],
      [
        {
          country: "US",
          views: "7",
          sessions: "4",
          visitors: "3",
        },
      ],
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          city: "San Francisco",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    const withoutGeo = await handleOverviewGeoPoints(
      env,
      siteId,
      url("/overview/geo-points", {
        from: window.startMs,
        to: window.endExclusiveMs,
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        limit: 9,
      }),
    );
    const withGeo = await handleOverviewGeoPoints(
      env,
      siteId,
      url("/overview/geo-points", {
        from: window.startMs,
        to: window.endExclusiveMs,
        "filter[geo.country]": "US",
        "filter[geo.region]": "California",
        applyGeoFilter: true,
        limit: 10,
      }),
    );

    await expect(withoutGeo.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          latitude: 37.7,
          longitude: -122.4,
          timestampMs: window.startMs,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "US", views: 7, sessions: 4, visitors: 3 }],
      regionCounts: [],
      cityCounts: [],
    });
    await expect(withGeo.json()).resolves.toEqual({
      ok: true,
      data: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
    expect(calls[0].bindings.at(-1)).toBe(9);
    expect(calls[2].bindings.at(-1)).toBe(10);
    expect(calls[2].bindings).toEqual(
      expect.arrayContaining(["us", "california"]),
    );
  });

  it("rejects invalid overview windows before querying D1", async () => {
    const { env, prepare } = createD1Env([]);

    const response = await handleOverview(
      env,
      siteId,
      new URL("https://edge.test/overview?from=20&to=10"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
