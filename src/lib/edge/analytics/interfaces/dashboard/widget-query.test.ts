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
