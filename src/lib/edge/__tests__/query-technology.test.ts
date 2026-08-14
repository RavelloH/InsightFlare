import { describe, expect, it, vi } from "vitest";

import type { DashboardFilters, QueryWindow } from "@/lib/edge/query/core";
import {
  BROWSER_VERSION_UNKNOWN_TOKEN,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/query/core";
import {
  parseClientDimensionKey,
  parseUtmDimensionKey,
  queryBrowserVersionBreakdownFromD1,
  queryShareTrendFromD1,
} from "@/lib/edge/query/technology";
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
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: Array<string | number | null>) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
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

    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain("TRIM(COALESCE(browser, '')) AS labelValue");
    expect(calls[0].sql).toContain("LOWER(TRIM(COALESCE(country, ''))) = ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(siteId, window),
      "us",
      "desktop",
      12,
    ]);
    expect(calls[1].sql).toContain(
      "assignedLabel IN (?, ?) THEN assignedLabel",
    );
    expect(calls[1].bindings).toEqual([
      ...visitBindings(siteId, window),
      "us",
      "desktop",
      "Chrome",
      "Firefox",
    ]);
    expect(calls[2].sql).toContain("CASE WHEN started_at >=");
    expect(calls[2].bindings).toEqual([
      ...visitBindings(siteId, window),
      "us",
      "desktop",
      "Chrome",
      "Firefox",
    ]);
  });
});
