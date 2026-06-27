import { describe, expect, it, vi } from "vitest";

import type { DashboardFilters, QueryWindow } from "@/lib/edge/query/core";
import {
  handleFilterOptions,
  handleOverview,
  handleOverviewClientTab,
  handleOverviewGeoPoints,
  handleOverviewGeoTab,
  handleOverviewPageTab,
  handleOverviewSourceTab,
  handleTrend,
  queryOverviewFromD1,
  queryTrendFromD1,
} from "@/lib/edge/query/overview";
import {
  handleDimension,
  handlePages,
  handlePagesDashboard,
  handleReferrers,
  queryPageCardMetricsFromD1,
  queryPageCardTitlesFromD1,
  queryPageCardTrendFromD1,
  queryTopPagesFromD1,
} from "@/lib/edge/query/pages";
import type { Env } from "@/lib/edge/types";

type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const siteId = "site-pages";
const baseMs = Date.UTC(2026, 0, 2, 1);
const window: QueryWindow = {
  fromMs: baseMs,
  toMs: baseMs + 2 * 60 * 60 * 1000,
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
  return [siteId, targetWindow.fromMs, targetWindow.toMs];
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
      queryTopPagesFromD1(env, siteId, window, 15, true, {
        country: "US",
        hostname: "Example.COM",
        path: "/pricing",
      }),
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
      "/pricing",
      "example.com",
      15,
    ]);
  });

  it("omits query and hash details when details are disabled", async () => {
    const { env, calls } = createD1Env([[{ pathname: "/docs", views: 3 }]]);

    await expect(
      queryTopPagesFromD1(env, siteId, window, 5, false, {}),
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
      queryTopPagesFromD1(env, siteId, window, 1, true, {}),
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
        { browser: "Chrome" },
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
      queryPageCardMetricsFromD1(env, siteId, window, {}, undefined),
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

  it("returns empty title and trend queries without touching D1 when pathnames are empty", async () => {
    const { env, prepare } = createD1Env([]);

    await expect(
      queryPageCardTitlesFromD1(env, siteId, window, {}, ["", "  "], 3),
    ).resolves.toEqual([]);
    await expect(
      queryPageCardTrendFromD1(env, siteId, window, "hour", {}, []),
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
        { clientDeviceType: "desktop" },
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
        { clientDeviceType: "desktop" },
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
      queryPageCardTitlesFromD1(env, siteId, window, {}, ["/pricing"], 3),
    ).resolves.toEqual([{ pathname: "", title: "", views: 0 }]);
    await expect(
      queryPageCardTrendFromD1(env, siteId, window, "hour", {}, ["/pricing"]),
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
});

describe("edge pages handlers", () => {
  it("maps pages and all tabs from D1 when includeTabs is enabled", async () => {
    const { env, calls } = createD1Env([
      [{ pathname: "/home", queryValue: "x=1", hashValue: "", views: 7 }],
      [
        {
          visitorId: "visitor-1",
          sessionId: "session-1",
          startedAt: window.fromMs,
          pathname: "/home",
          title: "Home",
          hostname: "example.com",
        },
        {
          visitorId: "visitor-1",
          sessionId: "session-1",
          startedAt: window.fromMs + 1,
          pathname: "/pricing",
          title: "Pricing",
          hostname: "example.com",
        },
        {
          visitorId: "visitor-2",
          sessionId: "session-2",
          startedAt: window.fromMs + 2,
          pathname: "/home",
          title: "Home",
          hostname: "example.com",
        },
      ],
    ]);

    const response = await handlePages(
      env,
      siteId,
      url("/pages", {
        from: window.fromMs,
        to: window.toMs,
        details: true,
        country: "US",
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
    expect(calls[0].bindings).toEqual([...visitBindings(), "us", 5]);
    expect(calls[1].bindings).toEqual([...visitBindings(), "us"]);
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
        from: window.fromMs,
        to: window.toMs,
        fullUrl: true,
        browser: "Chrome",
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
    expect(calls[0].bindings).toEqual([...visitBindings(), "Chrome", 7]);
  });

  it("maps dimension handler rows and can ignore geo filters", async () => {
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

    const response = await handleDimension(
      env,
      siteId,
      url("/dimension", {
        from: window.fromMs,
        to: window.toMs,
        geo: "US::CA::California",
        device: "desktop",
        limit: 4,
      }),
      "browser",
      { ignoreGeo: true },
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: [
        {
          label: "Chrome",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
    expect(calls[0].sql).toContain("COALESCE(browser, '') AS value");
    expect(calls[0].bindings).toEqual([...visitBindings(), "desktop", 4]);
  });

  it("returns an empty dashboard page without loading previous, titles, or trend rows", async () => {
    const { env, calls } = createD1Env([[]]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.fromMs,
        to: window.toMs,
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
    expect(calls[0].bindings).toEqual([...visitBindings(), 5, 4]);
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
        { pathname: "/pricing", title: " Pricing ", views: 8 },
        { pathname: "/pricing", title: "Pricing", views: 2 },
        { pathname: "/docs", title: "Docs", views: 4 },
      ],
      [
        { pathname: "/pricing", bucket: 0, views: 6, visitors: 3 },
        { pathname: "/docs", bucket: 1, views: 4, visitors: 2 },
      ],
    ]);

    const response = await handlePagesDashboard(
      env,
      siteId,
      url("/pages/dashboard", {
        from: window.fromMs,
        to: window.toMs,
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
    expect(calls).toHaveLength(4);
    expect(calls[0].bindings).toEqual([...visitBindings(), 3, 0]);
    expect(calls[1].bindings).toEqual([
      siteId,
      Math.max(window.fromMs - 1 - (window.toMs - window.fromMs), 0),
      window.fromMs - 1,
      "/pricing",
      "/docs",
    ]);
    expect(calls[2].bindings).toEqual([
      ...visitBindings(),
      "/pricing",
      "/docs",
      3,
    ]);
    expect(calls[3].bindings).toEqual([
      ...visitBindings(),
      "/pricing",
      "/docs",
    ]);
  });
});

describe("edge overview D1 queries and handlers", () => {
  it("maps overview aggregate fallback values and applies filters", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryOverviewFromD1(env, siteId, window, {
        country: "US",
        clientBrowser: "Chrome",
      }),
    ).resolves.toEqual({
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    });

    expect(calls[0].sql).toContain("session_rollup AS");
    expect(calls[0].bindings).toEqual([...visitBindings(), "us", "Chrome"]);
  });

  it("maps trend rows, bucket timestamps, and filter bindings", async () => {
    const filters: DashboardFilters = {
      sourceDomain: "Ref.Example",
      clientDeviceType: "mobile",
    };
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
      "ref.example",
      "mobile",
    ]);
  });

  it("returns overview metrics with previous change rates and detail trend mapping", async () => {
    const { env, calls } = createD1Env([
      [],
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
      [],
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
      [],
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
        from: window.fromMs,
        to: window.toMs,
        interval: "hour",
        includeChange: true,
        includeDetail: true,
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
    expect(calls).toHaveLength(6);
    expect(calls[0].sql).toContain("visit_hourly_aggregation_state");
    expect(calls[1].bindings).toEqual(visitBindings());
    expect(calls[2].sql).toContain("visit_hourly_aggregation_state");
    expect(calls[3].bindings).toEqual([
      siteId,
      Math.max(window.fromMs - 1 - (window.toMs - window.fromMs), 0),
      window.fromMs - 1,
    ]);
    expect(calls[4].sql).toContain("visit_hourly_aggregation_state");
    expect(calls[5].bindings).toEqual(visitBindings());
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
        from: window.fromMs,
        to: window.toMs,
        interval: "hour",
        sourceDomain: "Ref.Example",
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
    expect(calls[0].bindings).toEqual([...visitBindings(), "ref.example"]);
  });

  it("maps overview page, source, client, and geo tab handlers", async () => {
    const { env, calls } = createD1Env([
      [
        {
          visitorId: "visitor-1",
          sessionId: "session-1",
          startedAt: window.fromMs,
          pathname: "/home",
          title: "Home",
          hostname: "example.com",
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
          sessionId: "session-1",
          browser: "Chrome",
          os: "macOS",
          osVersion: "14",
          deviceType: "desktop",
          language: "en-US",
          screenWidth: 1440,
          screenHeight: 900,
        },
        {
          sessionId: "session-2",
          browser: "Chrome",
          os: "macOS",
          osVersion: "14",
          deviceType: "desktop",
          language: "en-US",
          screenWidth: 1440,
          screenHeight: 900,
        },
      ],
      [
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          country: "US",
          region: "US::CA::California",
          city: "US::CA::California::San Francisco",
          continent: "NA",
          timezone: "America/Los_Angeles",
          asOrganization: "Example ISP",
        },
      ],
    ]);

    const pageTab = await handleOverviewPageTab(
      env,
      siteId,
      url("/overview/page-tab", {
        from: window.fromMs,
        to: window.toMs,
        limit: 2,
      }),
      "path",
    );
    const sourceTab = await handleOverviewSourceTab(
      env,
      siteId,
      url("/overview/source-tab", {
        from: window.fromMs,
        to: window.toMs,
        limit: 3,
      }),
      "domain",
    );
    const clientTab = await handleOverviewClientTab(
      env,
      siteId,
      url("/overview/client-tab", {
        from: window.fromMs,
        to: window.toMs,
        limit: 3,
      }),
      "screenSize",
    );
    const geoTab = await handleOverviewGeoTab(
      env,
      siteId,
      url("/overview/geo-tab", {
        from: window.fromMs,
        to: window.toMs,
        geo: "US::CA::California",
        limit: 3,
      }),
      "country",
    );

    await expect(pageTab.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "/home", views: 1, sessions: 1, visitors: 1 }],
    });
    await expect(sourceTab.json()).resolves.toEqual({
      ok: true,
      data: [{ label: "", views: 4, sessions: 2, visitors: 2 }],
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
    expect(calls.map((call) => call.bindings)).toEqual([
      visitBindings(),
      [...visitBindings(), 3],
      visitBindings(),
      visitBindings(),
    ]);
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
          visitorId: "visitor-1",
          sessionId: "session-1",
          startedAt: window.fromMs,
          pathname: "/home",
          title: "Home",
          hostname: "example.com",
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
          sessionId: "session-1",
          browser: "Chrome",
          os: "macOS",
          osVersion: "14",
          deviceType: "desktop",
          language: "en-US",
          screenWidth: 390,
          screenHeight: 844,
        },
      ],
      [
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          country: "US",
          region: "US::CA::California",
          city: "US::CA::California::San Francisco",
          continent: "NA",
          timezone: "America/Los_Angeles",
          asOrganization: "Example ISP",
        },
      ],
      [
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          country: "US",
          region: "US::CA::California",
          city: "US::CA::California::San Francisco",
          continent: "NA",
          timezone: "America/Los_Angeles",
          asOrganization: "Example ISP",
        },
      ],
    ]);

    const scalar = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "country",
        country: "US",
        browser: "Chrome",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const page = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "path",
        path: "/home",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const source = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "sourceDomain",
        sourceDomain: "__direct__",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const client = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "clientScreenSize",
        clientScreenSize: "390x844",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const geo = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "geo",
        geo: "US::CA::California",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const geoOrganization = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "geoOrganization",
        geoOrganization: "Example ISP",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );

    await expect(scalar.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "US", label: "US" }],
    });
    await expect(page.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "/home", label: "/home" }],
    });
    await expect(source.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "__direct__", label: "__direct__" }],
    });
    await expect(client.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "390x844", label: "390x844" }],
    });
    await expect(geo.json()).resolves.toEqual({
      ok: true,
      data: [
        { value: "US", label: "US", group: "country" },
        {
          value: "US::CA::California",
          label: "California",
          group: "region",
        },
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          group: "city",
        },
      ],
    });
    await expect(geoOrganization.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "Example ISP", label: "Example ISP" }],
    });
    expect(calls.map((call) => call.bindings)).toEqual([
      [...visitBindings(), "Chrome", 4],
      visitBindings(),
      [...visitBindings(), 4],
      visitBindings(),
      visitBindings(),
      visitBindings(),
    ]);
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

    const device = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "device",
        device: "desktop",
        browser: "Chrome",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );
    const browser = await handleFilterOptions(
      env,
      siteId,
      url("/filter-options", {
        filterKey: "browser",
        browser: "Chrome",
        country: "US",
        from: window.fromMs,
        to: window.toMs,
        limit: 4,
      }),
    );

    await expect(device.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "desktop", label: "desktop" }],
    });
    await expect(browser.json()).resolves.toEqual({
      ok: true,
      data: [{ value: "Chrome", label: "Chrome" }],
    });
    expect(calls[0].sql).toContain("COALESCE(device_type, '') AS value");
    expect(calls[1].sql).toContain("COALESCE(browser, '') AS value");
    expect(calls.map((call) => call.bindings)).toEqual([
      [...visitBindings(), "Chrome", 4],
      [...visitBindings(), "us", 4],
    ]);
  });

  it("maps overview geo points with and without applying geo filters", async () => {
    const { env, calls } = createD1Env([
      [
        {
          latitude: "37.7",
          longitude: "-122.4",
          timestampMs: String(window.fromMs),
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
        from: window.fromMs,
        to: window.toMs,
        geo: "US::CA::California",
        limit: 9,
      }),
    );
    const withGeo = await handleOverviewGeoPoints(
      env,
      siteId,
      url("/overview/geo-points", {
        from: window.fromMs,
        to: window.toMs,
        geo: "US::CA::California",
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
          timestampMs: window.fromMs,
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
    expect(calls[0].bindings).toEqual([...visitBindings(), 9]);
    expect(calls[2].bindings).toEqual([
      ...visitBindings(),
      "us",
      "CA",
      "CALIFORNIA",
      10,
    ]);
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
