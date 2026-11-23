// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryWidgetData } from "@/lib/edge/analytics/interfaces/dashboard/widget-query";
import type { Env } from "@/lib/edge/types";
import { widgetConfigSchema } from "@/lib/widgets/contract";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/edge/analytics/composition", () => ({
  createEdgeSiteAnalyticsRuntime: () => ({ execute: mocks.execute }),
}));

const config = widgetConfigSchema.parse({
  title: "Widgets",
  type: "metric",
  metric: "visitors",
  range: "7d",
  timeZone: "UTC",
  locale: "en",
  theme: "auto",
  embedMode: "any",
  allowedOrigins: [],
  comparison: false,
  dimension: "page.path",
  limit: 5,
});
const window = {
  startMs: Date.UTC(2026, 10, 1),
  endExclusiveMs: Date.UTC(2026, 10, 8),
  timeZone: "UTC",
  nowMs: Date.UTC(2026, 10, 8),
};
const env = {} as Env;
const query = (partial: Partial<typeof config>) =>
  queryWidgetData(env, "site-1", { ...config, ...partial }, window);

describe("published widget aggregate adapters", () => {
  beforeEach(() => mocks.execute.mockReset());

  it("computes derived metrics from the existing overview data", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        current: {
          views: 320,
          visitors: 90,
          sessions: 100,
          bounces: 25,
          totalDurationMs: 180000,
          durationViews: 100,
        },
      },
    });
    const bounceRate = await query({ type: "metric", metric: "bounceRate" });
    expect(bounceRate).toMatchObject({ type: "metric", value: 0.25 });
    const duration = await query({ type: "metric", metric: "avgDurationMs" });
    expect(duration).toMatchObject({ type: "metric", value: 1800 });
    expect(mocks.execute.mock.calls.map((c) => c[0])).toEqual([
      "overview",
      "overview",
    ]);
  });

  it("returns multiple trend series from one underlying query", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        points: [
          { timestampMs: 100, visitors: 2, views: 5, sessions: 3 },
          { timestampMs: 200, visitors: 3, views: 7, sessions: 4 },
        ],
      },
    });
    const data = await query({
      type: "trend",
      metric: "visitors",
      trendMetrics: ["visitors", "views", "sessions"],
    });
    expect(data.type).toBe("trend");
    if (data.type !== "trend") throw new Error("wrong data");
    expect(data.series?.map((series) => series.metric)).toEqual([
      "visitors",
      "views",
      "sessions",
    ]);
    expect(data.series?.[1]?.points.map((point) => point.value)).toEqual([
      5, 7,
    ]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("computes distribution shares from displayed grouped categories only", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { key: "Desktop", visitors: 75 },
          { key: "Mobile", visitors: 25 },
        ],
      },
    });
    const data = await query({
      type: "distribution",
      distributionDimension: "client.deviceType",
    });
    expect(data.type).toBe("distribution");
    if (data.type !== "distribution") throw new Error("wrong data");
    expect(data.rows.map((row) => row.percent)).toEqual([0.75, 0.25]);
    expect(mocks.execute).toHaveBeenCalledWith(
      "dimension",
      expect.objectContaining({
        dimension: "device_type",
        limit: 6,
      }),
    );
  });

  it("queries only the configured event in a fixed server context", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { timestampMs: 100, totalEvents: 2 },
          { timestampMs: 200, totalEvents: 3 },
        ],
      },
    });
    const data = await query({
      type: "conversion",
      metric: "events",
      conversionKind: "event",
      eventName: "sign_up",
    });
    expect(data).toMatchObject({
      type: "conversion",
      kind: "event",
      value: 5,
      rate: null,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      "event-trend",
      expect.objectContaining({
        eventName: "sign_up",
        context: expect.objectContaining({
          policy: expect.objectContaining({ audience: "private-dashboard" }),
        }),
      }),
    );
  });

  it("reads the selected goal conversion timeseries and computes the aggregate rate", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        goal: { id: "goal-a", name: "Signup" },
        timeseries: [
          {
            timestampMs: 100,
            sessions: { converted: 2, total: 10, conversionRate: 0.2 },
          },
          {
            timestampMs: 200,
            sessions: { converted: 5, total: 20, conversionRate: 0.25 },
          },
        ],
      },
    });
    const data = await query({
      type: "conversion",
      conversionKind: "goal",
      goalId: "goal-a",
    });
    expect(data).toMatchObject({
      type: "conversion",
      kind: "goal",
      label: "Signup",
      value: 7,
      total: 30,
    });
    if (data.type !== "conversion") throw new Error("wrong data");
    expect(data.rate).toBeCloseTo(7 / 30);
    expect(mocks.execute).toHaveBeenCalledWith(
      "goal-timeseries",
      expect.objectContaining({
        goalId: "goal-a",
        context: expect.objectContaining({
          policy: expect.objectContaining({ audience: "private-dashboard" }),
        }),
      }),
    );
  });
});

describe("public geographic widget data", () => {
  beforeEach(() => mocks.execute.mockReset());

  it("returns bounded country aggregates with real representative positions", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { key: "US", visitors: 60 },
          { key: "SG", visitors: 20 },
          { key: "ZZ", visitors: 5 },
          { key: "", visitors: 4 },
        ],
      },
    });
    const data = await query({
      type: "geo",
      metric: "visitors",
      geoProjection: "flat",
    });
    expect(data.type).toBe("geo");
    if (data.type !== "geo") throw new Error("Not geo");
    expect(data.points.map((point) => point.country)).toEqual(["US", "SG"]);
    expect(data.points[0]).toMatchObject({ country: "US", value: 60 });
    expect(data.points[1]?.lat).toBeCloseTo(1.37);
    expect(data.unmapped).toBe(9);
    expect(mocks.execute).toHaveBeenCalledWith(
      "dimension",
      expect.objectContaining({
        mode: "breakdown",
        dimension: "country",
        limit: 220,
        context: expect.objectContaining({
          policy: expect.objectContaining({ audience: "public-share" }),
        }),
      }),
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown countries unpositioned instead of fabricating coordinates", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: { items: [{ key: "XX", sessions: 24 }] },
    });
    const data = await query({
      type: "geo",
      metric: "sessions",
      geoProjection: "globe",
    });
    expect(data).toMatchObject({ type: "geo", points: [], unmapped: 24 });
  });
});

describe("public realtime Widget adapter", () => {
  const sample = {
    sampledAt: Date.UTC(2026, 10, 23, 13, 30),
    activeNow: 5,
    bars: Array.from({ length: 30 }, (_, i) => ({
      minute: i * 60_000,
      visitors: i % 3,
      views: i % 6,
    })),
    countries: [
      { country: "US", activeVisitors: 4 },
      { country: "JP", activeVisitors: 2 },
      { country: "ZZ", activeVisitors: 5 },
    ],
    pages: [
      { path: "/", activeVisitors: 4 },
      { path: "/private", activeVisitors: 1 },
      { path: "https://bad.example", activeVisitors: 9 },
    ],
  };
  const doFetch = vi.fn(async (_url: string) => Response.json(sample));
  const realtimeEnv = {
    INGEST_DO: {
      idFromName: (siteId: string) => siteId,
      get: () => ({ fetch: doFetch }),
    },
  } as unknown as Env;

  it("shares one protected DO aggregate across all display layouts", async () => {
    doFetch.mockClear();
    for (const layout of ["badge", "trend", "map", "pages"] as const) {
      const data = await queryWidgetData(realtimeEnv, "site-1", {
        ...config,
        type: "realtime",
        realtimeLayout: layout,
      });
      expect(data.type).toBe("realtime");
      if (data.type !== "realtime") throw new Error("Unexpected widget");
      expect(data.activeNow).toBe(5);
      expect(data.bars.length).toBe(layout === "trend" ? 30 : 0);
      expect(data.points.map((point) => point.country)).toEqual(
        layout === "map" ? ["US"] : [],
      );
      expect(data.rows.map((row) => row.label)).toEqual(
        layout === "pages" ? ["/"] : [],
      );
      expect(JSON.stringify(data)).not.toContain("visitorId");
    }
    expect(doFetch).toHaveBeenCalledTimes(4);
    expect(doFetch.mock.calls[0]?.[0]).toBe(
      "https://ingest.internal/widget-realtime",
    );
  });
});

describe("public widget data error and privacy boundary matrix", () => {
  beforeEach(() => mocks.execute.mockReset());

  const overview = (
    current: Record<string, number>,
    previous?: Record<string, number>,
  ) =>
    mocks.execute.mockResolvedValue({
      ok: true,
      data: { current, ...(previous ? { previous } : {}) },
    });

  it.each([
    ["visitors", 8],
    ["views", 16],
    ["sessions", 4],
    ["bounces", 1],
    ["bounceRate", 0.25],
    ["avgDurationMs", 750],
    ["viewsPerSession", 4],
  ] as const)(
    "computes %s directly from the authorised overview",
    async (metric, value) => {
      overview({
        visitors: 8,
        views: 16,
        sessions: 4,
        bounces: 1,
        totalDurationMs: 3000,
      });
      const result = await query({ type: "metric", metric, comparison: false });
      expect(result).toMatchObject({ type: "metric", value, change: null });
      expect(mocks.execute).toHaveBeenCalledWith(
        "overview",
        expect.objectContaining({
          context: expect.objectContaining({
            policy: expect.objectContaining({ audience: "public-share" }),
          }),
        }),
      );
    },
  );

  it.each(["bounceRate", "avgDurationMs", "viewsPerSession"] as const)(
    "has zero-safe %s when no sessions exist",
    async (metric) => {
      overview({
        visitors: 0,
        views: 0,
        sessions: 0,
        bounces: 0,
        totalDurationMs: 0,
      });
      const result = await query({ type: "metric", metric, comparison: false });
      expect(result).toMatchObject({ type: "metric", value: 0, change: null });
    },
  );

  it("returns normalized comparison rather than percent units", async () => {
    overview(
      {
        visitors: 200,
        views: 400,
        sessions: 100,
        bounces: 20,
        totalDurationMs: 1000,
      },
      {
        visitors: 100,
        views: 250,
        sessions: 80,
        bounces: 10,
        totalDurationMs: 1000,
      },
    );
    const result = await query({
      type: "metric",
      metric: "visitors",
      comparison: true,
    });
    expect(result).toMatchObject({ value: 200, change: 1 });
  });

  it("uses authorized private-dashboard aggregation for event metric", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: { summary: { events: 9 } },
    });
    const result = await query({
      type: "metric",
      metric: "events",
      comparison: false,
    });
    expect(result).toMatchObject({ type: "metric", value: 9, change: null });
    expect(mocks.execute).toHaveBeenCalledWith(
      "event-summary",
      expect.objectContaining({
        context: expect.objectContaining({
          policy: expect.objectContaining({ audience: "private-dashboard" }),
        }),
      }),
    );
  });

  it("computes event metric comparisons with the previous comparable window", async () => {
    mocks.execute
      .mockResolvedValueOnce({ ok: true, data: { summary: { events: 30 } } })
      .mockResolvedValueOnce({ ok: true, data: { summary: { events: 15 } } });
    const result = await query({
      type: "metric",
      metric: "events",
      comparison: true,
    });
    expect(result).toMatchObject({ value: 30, change: 1 });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    { type: "metric", metric: "views" },
    { type: "metric", metric: "events" },
    { type: "trend", metric: "visitors" },
    { type: "ranking", metric: "visitors" },
    { type: "distribution", metric: "visitors" },
    { type: "geo", metric: "visitors" },
    {
      type: "conversion",
      metric: "events",
      conversionKind: "event",
      eventName: "sign_up",
    },
    {
      type: "conversion",
      metric: "visitors",
      conversionKind: "goal",
      goalId: "goal-a",
    },
  ] as const)(
    "rejects failed aggregate query: $type/$metric",
    async (partial) => {
      mocks.execute.mockResolvedValue({
        ok: false,
        error: { code: "unavailable" },
      });
      await expect(query(partial)).rejects.toThrow(/Widget .* query failed/);
    },
  );

  it("fails closed on an invalid comparison aggregate", async () => {
    mocks.execute
      .mockResolvedValueOnce({ ok: true, data: { summary: { events: 5 } } })
      .mockResolvedValueOnce({ ok: false, error: { code: "forbidden" } });
    await expect(
      query({ type: "metric", metric: "events", comparison: true }),
    ).rejects.toThrow("Widget event comparison failed");
  });

  it("preserves missing event comparison and empty goal denominator", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: { summary: { events: 0 } },
    });
    expect(
      await query({ type: "metric", metric: "events", comparison: false }),
    ).toMatchObject({ value: 0, change: null });
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: {
        goal: { name: "Test" },
        timeseries: [
          {
            timestampMs: 100,
            sessions: { total: 0, converted: 0, conversionRate: 0 },
          },
        ],
      },
    });
    const goal = await query({
      type: "conversion",
      conversionKind: "goal",
      goalId: "goal-a",
    });
    expect(goal).toMatchObject({ total: 0, value: 0, rate: null });
  });

  it("returns a compact one-series trend from one aggregate request", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: {
        points: [{ timestampMs: 10, views: 4, visitors: 3, sessions: 2 }],
      },
    });
    const trend = await query({
      type: "trend",
      metric: "views",
      trendMetrics: [],
    });
    expect(trend).toMatchObject({
      type: "trend",
      points: [{ timestampMs: 10, value: 4 }],
    });
    if (trend.type !== "trend") throw new Error("wrong type");
    expect(trend.series).toBeUndefined();
  });

  it.each([
    [
      "page.path",
      [
        { key: "/ok?utm_source=paid", visitors: 7 },
        { key: "https://evil.test/open", visitors: 11 },
        { key: "  ", visitors: 2 },
        { key: "/docs#section", visitors: 4 },
      ],
      ["/ok", "/docs"],
    ],
    [
      "source.domain",
      [
        { key: "news.example.com", visitors: 7 },
        { key: "invalid host/name", visitors: 4 },
        { key: "x-y.test", visitors: 2 },
      ],
      ["news.example.com", "x-y.test"],
    ],
    [
      "geo.country",
      [
        { key: "us", visitors: 7 },
        { key: "not-a-code", visitors: 9 },
        { key: " jp ", visitors: 3 },
      ],
      ["US", "JP"],
    ],
  ] as const)(
    "sanitizes %s labels before publishing",
    async (dimension, items, labels) => {
      mocks.execute.mockResolvedValueOnce({ ok: true, data: { items } });
      const result = await query({
        type: "ranking",
        dimension,
        metric: "visitors",
      });
      expect(result.type).toBe("ranking");
      if (result.type !== "ranking") throw new Error("wrong type");
      expect(result.rows.map((r) => r.label)).toEqual(labels);
    },
  );

  it("uses the chosen distribution dimension and emits no NaN for empty groups", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { key: "desktop", visitors: 0 },
          { key: "", visitors: 0 },
          { key: "mobile", visitors: 0 },
        ],
      },
    });
    const result = await query({
      type: "distribution",
      distributionDimension: "utm.source",
    });
    expect(result).toMatchObject({
      type: "distribution",
      rows: [
        { label: "desktop", percent: 0 },
        { label: "mobile", percent: 0 },
      ],
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      "dimension",
      expect.objectContaining({ dimension: "utm_source" }),
    );
  });

  it("rejects malformed analytics breakdown shapes", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { unexpected: true } });
    await expect(query({ type: "geo" })).rejects.toThrow(
      /geographic breakdown/,
    );
    await expect(query({ type: "ranking" })).rejects.toThrow(
      /ranking query failed/,
    );
  });

  it("ignores invalid and zero geographic values instead of inventing locations", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          { key: "US", visitors: 0 },
          { key: "DE", visitors: Number.NaN },
          { key: "SG", visitors: 5 },
          { key: "unknown", visitors: 3 },
        ],
      },
    });
    const result = await query({ type: "geo", metric: "visitors" });
    expect(result).toMatchObject({ type: "geo", unmapped: 3 });
    if (result.type !== "geo") throw new Error("wrong type");
    expect(result.points.map((x) => x.country)).toEqual(["SG"]);
  });

  const snapshot = {
    sampledAt: 600000,
    activeNow: 4,
    bars: [
      { minute: 100, visitors: -1, views: 2 },
      { minute: 200, visitors: 2, views: -2 },
    ],
    countries: [
      { country: "US", activeVisitors: 3 },
      { country: "JP", activeVisitors: 2 },
      { country: "UNKNOWN", activeVisitors: 5 },
    ],
    pages: [
      { path: "/a", activeVisitors: 5 },
      { path: "/b", activeVisitors: 2 },
      { path: "https://evil.test", activeVisitors: 10 },
      { path: "/" + "x".repeat(513), activeVisitors: 10 },
    ],
  };

  const realtime = (
    response: () => Promise<Response>,
    layout: "badge" | "map" | "trend" | "pages" = "badge",
  ) =>
    queryWidgetData(
      {
        INGEST_DO: {
          idFromName: (siteId: string) => siteId,
          get: () => ({ fetch: response }),
        },
      } as unknown as Env,
      "site-1",
      { ...config, type: "realtime", realtimeLayout: layout },
      window,
    );

  it("rejects upstream realtime errors and malformed aggregates", async () => {
    await expect(
      realtime(async () => new Response(null, { status: 503 })),
    ).rejects.toThrow("Realtime Widget aggregate unavailable");
    for (const malformed of [
      { ...snapshot, activeNow: -1 },
      { ...snapshot, activeNow: 1.5 },
      { ...snapshot, sampledAt: Number.NaN },
      { ...snapshot, bars: null },
      { ...snapshot, countries: null },
      { ...snapshot, pages: null },
    ]) {
      await expect(
        realtime(async () => Response.json(malformed)),
      ).rejects.toThrow("Invalid realtime Widget aggregate");
    }
  });

  it("aggregates country data only when a bucket has at least three active visitors", async () => {
    const result = await realtime(async () => Response.json(snapshot), "map");
    expect(result.type).toBe("realtime");
    if (result.type !== "realtime") throw new Error("wrong type");
    expect(result.points.map((x) => x.country)).toEqual(["US"]);
    expect(result.bars).toEqual([]);
  });

  it("filters unsafe pages and exposes only sufficiently active paths", async () => {
    const result = await realtime(async () => Response.json(snapshot), "pages");
    expect(result.type).toBe("realtime");
    if (result.type !== "realtime") throw new Error("wrong type");
    expect(result.rows).toEqual([{ label: "/a", value: 5 }]);
  });

  it("clamps negative minute buckets and skips non-finite values", async () => {
    const result = await realtime(
      async () =>
        Response.json({
          ...snapshot,
          bars: [
            ...snapshot.bars,
            { minute: 300, visitors: Number.NaN, views: 3 },
          ],
        }),
      "trend",
    );
    expect(result.type).toBe("realtime");
    if (result.type !== "realtime") throw new Error("wrong type");
    expect(result.bars).toEqual([
      { minute: 100, visitors: 0, views: 2 },
      { minute: 200, visitors: 2, views: 0 },
    ]);
  });
});
