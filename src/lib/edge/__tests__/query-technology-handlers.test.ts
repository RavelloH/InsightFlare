import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserCrossBreakdownDimensionDataRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
} from "@/lib/edge/query/core";
import {
  handleBrowserCrossBreakdown,
  handleBrowserEngineTrend,
  handleBrowserRadar,
  handleBrowserTrend,
  handleBrowserVersionBreakdown,
  handleClientDimensionTrend,
  handleCrossBreakdown,
  handleReferrerDimensionTrend,
  handleReferrerRadar,
  handleUtmDimensionTrend,
} from "@/lib/edge/query/technology/handlers";
import type { Env } from "@/lib/edge/types";

const queryMocks = vi.hoisted(() => ({
  queryBrowserCrossBreakdownFromD1: vi.fn(),
  queryBrowserEngineTrendFromD1: vi.fn(),
  queryBrowserRadarFromD1: vi.fn(),
  queryBrowserTrendFromD1: vi.fn(),
  queryBrowserVersionBreakdownFromD1: vi.fn(),
  queryCrossDimensionFromD1: vi.fn(),
  queryClientDimensionTrendFromD1: vi.fn(),
  queryReferrerRadarFromD1: vi.fn(),
  queryReferrerTrendFromD1: vi.fn(),
  queryUtmDimensionTrendFromD1: vi.fn(),
}));

vi.mock("@/lib/edge/query/technology/browser", () => ({
  queryBrowserCrossBreakdownFromD1: queryMocks.queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1: queryMocks.queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1: queryMocks.queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1:
    queryMocks.queryBrowserVersionBreakdownFromD1,
}));

vi.mock("@/lib/edge/query/technology/client-cross", () => ({
  queryCrossDimensionFromD1: queryMocks.queryCrossDimensionFromD1,
}));

vi.mock("@/lib/edge/query/technology/radar", () => ({
  queryBrowserRadarFromD1: queryMocks.queryBrowserRadarFromD1,
  queryReferrerRadarFromD1: queryMocks.queryReferrerRadarFromD1,
}));

vi.mock("@/lib/edge/query/technology/share-trend", () => ({
  queryClientDimensionTrendFromD1: queryMocks.queryClientDimensionTrendFromD1,
  queryReferrerTrendFromD1: queryMocks.queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1: queryMocks.queryUtmDimensionTrendFromD1,
}));

const env = {
  DB: {},
  DAILY_SALT_SECRET: "test-secret",
  INGEST_DO: {},
} as unknown as Env;
const siteId = "site-1";
const fromMs = Date.UTC(2026, 0, 1, 0, 0);
const toMs = Date.UTC(2026, 0, 1, 1, 0);

type Handler = (env: Env, siteId: string, url: URL) => Promise<Response>;

function testUrl(params: Record<string, string | number | undefined> = {}) {
  const url = new URL("https://edge.example.test/query");
  url.searchParams.set("from", String(fromMs));
  url.searchParams.set("to", String(toMs));
  url.searchParams.set("timeZone", "Asia/Shanghai");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function parsedWindow() {
  return expect.objectContaining({
    fromMs,
    toMs,
    timeZone: "Asia/Shanghai",
  });
}

function expectNoQueryCalls() {
  expect(queryMocks.queryBrowserCrossBreakdownFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryBrowserEngineTrendFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryBrowserRadarFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryBrowserTrendFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryBrowserVersionBreakdownFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryCrossDimensionFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryClientDimensionTrendFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryReferrerRadarFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryReferrerTrendFromD1).not.toHaveBeenCalled();
  expect(queryMocks.queryUtmDimensionTrendFromD1).not.toHaveBeenCalled();
}

const trendSeries: BrowserTrendSeriesRow[] = [
  { key: "chrome", label: "Chrome", views: 12, visitors: 7, sessions: 5 },
];
const trendData: BrowserTrendPointRow[] = [
  {
    bucket: 0,
    timestampMs: fromMs,
    totalVisitors: 7,
    visitorsBySeries: { chrome: 7 },
  },
];
const trendResult = { series: trendSeries, data: trendData };
const emptyCrossData: BrowserCrossBreakdownDimensionDataRow = {
  columns: [],
  rows: [],
  totalVisitors: 0,
};

describe("edge query technology handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<[string, Handler, Record<string, string>]>([
    ["browser trend", handleBrowserTrend, {}],
    ["browser engine trend", handleBrowserEngineTrend, {}],
    ["browser version breakdown", handleBrowserVersionBreakdown, {}],
    ["browser cross breakdown", handleBrowserCrossBreakdown, {}],
    ["browser radar", handleBrowserRadar, {}],
    ["referrer radar", handleReferrerRadar, {}],
    [
      "client dimension trend",
      handleClientDimensionTrend,
      { dimension: "browser" },
    ],
    ["UTM dimension trend", handleUtmDimensionTrend, { dimension: "source" }],
    ["referrer dimension trend", handleReferrerDimensionTrend, {}],
    [
      "client cross breakdown",
      handleCrossBreakdown,
      {
        primaryDimension: "client.browser",
        secondaryDimension: "client.deviceType",
      },
    ],
  ])("rejects invalid time windows for %s", async (_label, handler, params) => {
    const response = await handler(
      env,
      siteId,
      testUrl({ ...params, from: toMs + 1, to: toMs }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expectNoQueryCalls();
  });

  it("passes parsed browser trend arguments and caps the limit", async () => {
    queryMocks.queryBrowserTrendFromD1.mockResolvedValue(trendResult);

    const response = await handleBrowserTrend(
      env,
      siteId,
      testUrl({
        interval: "hour",
        limit: "99",
        country: " US ",
        clientDeviceType: "desktop",
      }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      interval: "hour",
      series: trendSeries,
      data: trendData,
    });
    expect(queryMocks.queryBrowserTrendFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      "hour",
      expect.objectContaining({ country: "US", clientDeviceType: "desktop" }),
      12,
    );
  });

  it("falls back browser engine trend interval and limit", async () => {
    queryMocks.queryBrowserEngineTrendFromD1.mockResolvedValue(trendResult);

    const response = await handleBrowserEngineTrend(
      env,
      siteId,
      testUrl({ interval: "fortnight", limit: "0" }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      interval: "day",
      series: trendSeries,
      data: trendData,
    });
    expect(queryMocks.queryBrowserEngineTrendFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      "day",
      expect.any(Object),
      5,
    );
  });

  it("normalizes browser and version breakdown limits", async () => {
    const data = [
      {
        browser: "Chrome",
        views: 12,
        visitors: 7,
        sessions: 5,
        versions: [],
      },
    ];
    queryMocks.queryBrowserVersionBreakdownFromD1
      .mockResolvedValueOnce(data)
      .mockResolvedValueOnce(data);

    const cappedResponse = await handleBrowserVersionBreakdown(
      env,
      siteId,
      testUrl({ browserLimit: "2.9", versionLimit: "99" }),
    );
    const minimumResponse = await handleBrowserVersionBreakdown(
      env,
      siteId,
      testUrl({ browserLimit: "-2", versionLimit: "0" }),
    );

    expect(await responseJson(cappedResponse)).toEqual({ ok: true, data });
    expect(await responseJson(minimumResponse)).toEqual({ ok: true, data });
    expect(
      queryMocks.queryBrowserVersionBreakdownFromD1,
    ).toHaveBeenNthCalledWith(
      1,
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
      2,
      8,
    );
    expect(
      queryMocks.queryBrowserVersionBreakdownFromD1,
    ).toHaveBeenNthCalledWith(
      2,
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
      0,
      1,
    );
  });

  it("passes parsed browser cross breakdown limits and wraps response data", async () => {
    queryMocks.queryBrowserCrossBreakdownFromD1.mockResolvedValue({
      operatingSystem: emptyCrossData,
      deviceType: emptyCrossData,
    });

    const response = await handleBrowserCrossBreakdown(
      env,
      siteId,
      testUrl({ browserLimit: "0", osLimit: "99", deviceTypeLimit: "2.7" }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      operatingSystem: emptyCrossData,
      deviceType: emptyCrossData,
    });
    expect(queryMocks.queryBrowserCrossBreakdownFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
      1,
      8,
      2,
    );
  });

  it("maps browser radar engagement and zero-denominator metrics", async () => {
    queryMocks.queryBrowserRadarFromD1.mockResolvedValue([
      {
        browser: "Chrome",
        visitors: 5,
        sessions: 4,
        bounces: 1,
        avgDurationMs: 1250,
        avgDepth: 2.5,
        returningVisitors: 2,
        avgFrequency: 1.4,
        trafficShare: 0.625,
      },
      {
        browser: "No sessions",
        visitors: 0,
        sessions: 0,
        bounces: 0,
        avgDurationMs: 0,
        avgDepth: 0,
        returningVisitors: 0,
        avgFrequency: 0,
        trafficShare: 0,
      },
    ]);

    const response = await handleBrowserRadar(env, siteId, testUrl());

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      data: [
        {
          browser: "Chrome",
          visitors: 5,
          sessions: 4,
          metrics: {
            duration: 1250,
            engagement: 0.75,
            depth: 2.5,
            loyalty: 0.4,
            frequency: 1.4,
            traffic: 0.625,
          },
        },
        {
          browser: "No sessions",
          visitors: 0,
          sessions: 0,
          metrics: {
            duration: 0,
            engagement: 0,
            depth: 0,
            loyalty: 0,
            frequency: 0,
            traffic: 0,
          },
        },
      ],
    });
    expect(queryMocks.queryBrowserRadarFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
    );
  });

  it("maps referrer radar metrics and caps the limit", async () => {
    queryMocks.queryReferrerRadarFromD1.mockResolvedValue([
      {
        referrer: "example.com",
        visitors: 3,
        sessions: 3,
        bounces: 1,
        avgDurationMs: 900,
        avgDepth: 1.75,
        returningVisitors: 1,
        avgFrequency: 1.2,
        trafficShare: 0.25,
      },
      {
        referrer: "",
        visitors: 0,
        sessions: 0,
        bounces: 0,
        avgDurationMs: 0,
        avgDepth: 0,
        returningVisitors: 0,
        avgFrequency: 0,
        trafficShare: 0,
      },
    ]);

    const response = await handleReferrerRadar(
      env,
      siteId,
      testUrl({ limit: "99" }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      data: [
        {
          referrer: "example.com",
          visitors: 3,
          sessions: 3,
          metrics: {
            duration: 900,
            engagement: 0.666667,
            depth: 1.75,
            loyalty: 0.333333,
            frequency: 1.2,
            traffic: 0.25,
          },
        },
        {
          referrer: "",
          visitors: 0,
          sessions: 0,
          metrics: {
            duration: 0,
            engagement: 0,
            depth: 0,
            loyalty: 0,
            frequency: 0,
            traffic: 0,
          },
        },
      ],
    });
    expect(queryMocks.queryReferrerRadarFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
      48,
    );
  });

  it("rejects invalid client and UTM trend dimensions before querying", async () => {
    const clientResponse = await handleClientDimensionTrend(
      env,
      siteId,
      testUrl({ dimension: "country" }),
    );
    const utmResponse = await handleUtmDimensionTrend(
      env,
      siteId,
      testUrl({ dimension: "utm_source" }),
    );

    expect(clientResponse.status).toBe(400);
    expect(await responseJson(clientResponse)).toMatchObject({
      ok: false,
      error: { message: "Invalid client dimension" },
    });
    expect(utmResponse.status).toBe(400);
    expect(await responseJson(utmResponse)).toMatchObject({
      ok: false,
      error: { message: "Invalid UTM dimension" },
    });
    expectNoQueryCalls();
  });

  it("passes parsed client dimension trend arguments", async () => {
    queryMocks.queryClientDimensionTrendFromD1.mockResolvedValue(trendResult);

    const response = await handleClientDimensionTrend(
      env,
      siteId,
      testUrl({ dimension: "browser", interval: "minute", limit: "99" }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      interval: "minute",
      series: trendSeries,
      data: trendData,
    });
    expect(queryMocks.queryClientDimensionTrendFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      "minute",
      expect.any(Object),
      "browser",
      8,
    );
  });

  it("passes parsed UTM and referrer trend arguments", async () => {
    queryMocks.queryUtmDimensionTrendFromD1.mockResolvedValue(trendResult);
    queryMocks.queryReferrerTrendFromD1.mockResolvedValue(trendResult);

    const utmResponse = await handleUtmDimensionTrend(
      env,
      siteId,
      testUrl({ dimension: "source", limit: "-1" }),
    );
    const referrerResponse = await handleReferrerDimensionTrend(
      env,
      siteId,
      testUrl({ interval: "month", limit: "99" }),
    );

    expect(await responseJson(utmResponse)).toEqual({
      ok: true,
      interval: "day",
      series: trendSeries,
      data: trendData,
    });
    expect(await responseJson(referrerResponse)).toEqual({
      ok: true,
      interval: "month",
      series: trendSeries,
      data: trendData,
    });
    expect(queryMocks.queryUtmDimensionTrendFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      "day",
      expect.any(Object),
      "source",
      5,
    );
    expect(queryMocks.queryReferrerTrendFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      "month",
      expect.any(Object),
      8,
    );
  });

  it("rejects invalid or duplicate client cross breakdown dimensions", async () => {
    const unsupportedPrimary = await handleCrossBreakdown(
      env,
      siteId,
      testUrl({
        primaryDimension: "session.entryPath",
        secondaryDimension: "client.browser",
      }),
    );
    const unsupportedSecondary = await handleCrossBreakdown(
      env,
      siteId,
      testUrl({
        primaryDimension: "client.browser",
        secondaryDimension: "event.name",
      }),
    );
    const duplicate = await handleCrossBreakdown(
      env,
      siteId,
      testUrl({
        primaryDimension: "client.browser",
        secondaryDimension: "client.browser",
      }),
    );

    expect(await responseJson(unsupportedPrimary)).toMatchObject({
      ok: false,
      error: { message: "Unsupported primary dimension" },
    });
    expect(await responseJson(unsupportedSecondary)).toMatchObject({
      ok: false,
      error: { message: "Unsupported secondary dimension" },
    });
    expect(await responseJson(duplicate)).toMatchObject({
      ok: false,
      error: { message: "Primary and secondary dimensions must differ" },
    });
    expectNoQueryCalls();
  });

  it("passes parsed client cross breakdown arguments and returns enveloped data", async () => {
    queryMocks.queryCrossDimensionFromD1.mockResolvedValue(emptyCrossData);

    const response = await handleCrossBreakdown(
      env,
      siteId,
      testUrl({
        primaryDimension: "client.browser",
        secondaryDimension: "client.deviceType",
        primaryLimit: "99",
        secondaryLimit: "0",
      }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      data: emptyCrossData,
    });
    expect(queryMocks.queryCrossDimensionFromD1).toHaveBeenCalledWith(
      env,
      siteId,
      parsedWindow(),
      expect.any(Object),
      12,
      1,
      expect.objectContaining({ fallbackKeyBase: "browser" }),
      expect.objectContaining({ fallbackKeyBase: "device" }),
    );
  });
});
