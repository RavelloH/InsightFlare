import { describe, expect, it, vi } from "vitest";

import type { QueryWindow } from "@/lib/edge/query/core";
import {
  BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  BROWSER_CROSS_UNKNOWN_TOKEN,
  BROWSER_VERSION_UNKNOWN_TOKEN,
  CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  CLIENT_CROSS_UNKNOWN_TOKEN,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/query/core";
import { clientDimensionDefinition } from "@/lib/edge/query/core";
import {
  queryBrowserCrossBreakdownFromD1,
  queryBrowserCrossDimensionFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "@/lib/edge/query/technology/browser";
import { queryCrossDimensionFromD1 } from "@/lib/edge/query/technology/client-cross";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/query/technology/radar";
import {
  queryClientDimensionTrendFromD1,
  queryReferrerTrendFromD1,
  queryShareTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "@/lib/edge/query/technology/share-trend";
import type { Env } from "@/lib/edge/types";

type D1Row = Record<string, unknown>;

interface QueryCall {
  sql: string;
  bindings: Array<string | number | null>;
}

const siteId = "site-technology";
const window: QueryWindow = {
  fromMs: Date.UTC(2026, 0, 1, 0),
  toMs: Date.UTC(2026, 0, 1, 2),
  nowMs: Date.UTC(2026, 0, 1, 3),
  timeZone: "UTC",
};

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

function visitBindings() {
  return [siteId, window.fromMs, window.toMs];
}

describe("edge technology query coverage", () => {
  it("returns an empty browser version breakdown without a browser limit", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryBrowserVersionBreakdownFromD1(
        env,
        siteId,
        window,
        {},
        Number.NaN,
        2,
      ),
    ).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain("LIMIT ?");
    expect(calls[0].bindings).toEqual(visitBindings());
  });

  it("maps browser version slices with unknown and other buckets", async () => {
    const { env, calls } = createD1Env([
      [
        { browser: " Chrome ", views: 20, visitors: 10, sessions: 8 },
        { browser: "Ignored", views: 9, visitors: 0, sessions: 0 },
      ],
      [
        {
          browser: "Chrome",
          version: "124",
          views: 8,
          visitors: 5,
          sessions: 4,
        },
        {
          browser: "Chrome",
          version: BROWSER_VERSION_UNKNOWN_TOKEN,
          views: 4,
          visitors: 3,
          sessions: 2,
        },
        {
          browser: "Chrome",
          version: "122",
          views: 3,
          visitors: 2,
          sessions: 2,
        },
        { browser: "", version: "121", views: 9, visitors: 9, sessions: 9 },
        {
          browser: "Chrome",
          version: "121",
          views: 9,
          visitors: 0,
          sessions: 0,
        },
      ],
    ]);

    await expect(
      queryBrowserVersionBreakdownFromD1(env, siteId, window, {}, 2.9, 2),
    ).resolves.toEqual([
      {
        browser: "Chrome",
        views: 20,
        visitors: 10,
        sessions: 8,
        versions: [
          { key: "124", label: "124", views: 8, visitors: 5, sessions: 4 },
          {
            key: "unknown",
            label: "Unknown",
            views: 4,
            visitors: 3,
            sessions: 2,
            isUnknown: true,
          },
          {
            key: "other",
            label: SHARE_TREND_OTHER_LABEL,
            views: 3,
            visitors: 2,
            sessions: 2,
            isOther: true,
          },
        ],
      },
    ]);

    expect(calls[0].sql).toContain("LIMIT ?");
    expect(calls[0].bindings.at(-1)).toBe(2);
    expect(calls[1].bindings).toEqual([...visitBindings(), "Chrome"]);
  });

  it("returns browser version rows with empty versions when all version rows are invalid", async () => {
    const { env } = createD1Env([
      [{ browser: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [
        {
          browser: "Chrome",
          version: "124",
          views: 5,
          visitors: 0,
          sessions: 0,
        },
        { browser: "", version: "123", views: 5, visitors: 3, sessions: 2 },
      ],
    ]);

    await expect(
      queryBrowserVersionBreakdownFromD1(env, siteId, window, {}, 1, 99),
    ).resolves.toEqual([
      {
        browser: "Chrome",
        views: 5,
        visitors: 3,
        sessions: 2,
        versions: [],
      },
    ]);
  });

  it("maps browser cross dimensions with unknown and other buckets", async () => {
    const { env, calls } = createD1Env([
      [
        { browser: "Chrome", views: 10, visitors: 8, sessions: 5 },
        { browser: "Safari", views: 7, visitors: 4, sessions: 4 },
        { browser: "Edge", views: 5, visitors: 3, sessions: 3 },
        { browser: "", views: 9, visitors: 9, sessions: 9 },
        { browser: "Ignored", views: 9, visitors: 0, sessions: 0 },
      ],
      [
        { dimension: "Windows", views: 8, visitors: 7, sessions: 5 },
        { dimension: "", views: 2, visitors: 2, sessions: 2 },
        { dimension: "Ignored", views: 9, visitors: 0, sessions: 0 },
      ],
      [
        {
          browser: "Chrome",
          dimension: "Windows",
          views: 4,
          visitors: 4,
          sessions: 3,
        },
        {
          browser: "Chrome",
          dimension: BROWSER_CROSS_UNKNOWN_TOKEN,
          views: 1,
          visitors: 1,
          sessions: 1,
        },
        {
          browser: "Chrome",
          dimension: BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
          views: 2,
          visitors: 2,
          sessions: 2,
        },
        {
          browser: "Safari",
          dimension: "Windows",
          views: 3,
          visitors: 3,
          sessions: 2,
        },
        {
          browser: BROWSER_CROSS_OTHER_BROWSER_TOKEN,
          dimension: "Windows",
          views: 2,
          visitors: 2,
          sessions: 1,
        },
        {
          browser: BROWSER_CROSS_OTHER_BROWSER_TOKEN,
          dimension: BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
          views: 1,
          visitors: 1,
          sessions: 1,
        },
        {
          browser: "",
          dimension: "Windows",
          views: 9,
          visitors: 9,
          sessions: 9,
        },
        {
          browser: "Chrome",
          dimension: "",
          views: 9,
          visitors: 9,
          sessions: 9,
        },
        {
          browser: "Chrome",
          dimension: "Windows",
          views: 9,
          visitors: 0,
          sessions: 0,
        },
      ],
    ]);

    const result = await queryBrowserCrossDimensionFromD1(
      env,
      siteId,
      window,
      {},
      99,
      0,
      "TRIM(COALESCE(os, ''))",
      "os",
    );

    expect(result.columns).toEqual([
      { key: "windows", label: "Windows", views: 8, visitors: 7, sessions: 5 },
      {
        key: "unknown",
        label: "Unknown",
        views: 2,
        visitors: 2,
        sessions: 2,
        isUnknown: true,
      },
      {
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: 3,
        visitors: 3,
        sessions: 3,
        isOther: true,
      },
    ]);
    expect(result.rows).toEqual([
      {
        key: "chrome",
        label: "Chrome",
        views: 7,
        visitors: 7,
        sessions: 6,
        cells: [
          {
            key: "windows",
            label: "Windows",
            views: 4,
            visitors: 4,
            sessions: 3,
          },
          {
            key: "unknown",
            label: "Unknown",
            views: 1,
            visitors: 1,
            sessions: 1,
            isUnknown: true,
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
      },
      {
        key: "safari",
        label: "Safari",
        views: 3,
        visitors: 3,
        sessions: 2,
        cells: [
          {
            key: "windows",
            label: "Windows",
            views: 3,
            visitors: 3,
            sessions: 2,
          },
          {
            key: "unknown",
            label: "Unknown",
            views: 0,
            visitors: 0,
            sessions: 0,
            isUnknown: true,
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
        key: "edge",
        label: "Edge",
        views: 5,
        visitors: 3,
        sessions: 3,
        cells: [
          {
            key: "windows",
            label: "Windows",
            views: 0,
            visitors: 0,
            sessions: 0,
          },
          {
            key: "unknown",
            label: "Unknown",
            views: 0,
            visitors: 0,
            sessions: 0,
            isUnknown: true,
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
        views: 3,
        visitors: 3,
        sessions: 2,
        isOther: true,
        cells: [
          {
            key: "windows",
            label: "Windows",
            views: 2,
            visitors: 2,
            sessions: 1,
          },
          {
            key: "unknown",
            label: "Unknown",
            views: 0,
            visitors: 0,
            sessions: 0,
            isUnknown: true,
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
    ]);
    expect(result.totalVisitors).toBe(16);
    expect(calls[0].bindings.at(-1)).toBe(12);
    expect(calls[1].bindings.at(-1)).toBe(1);
  });

  it("returns empty browser cross dimensions when top buckets are missing", async () => {
    const noBrowsers = createD1Env([[]]);
    const noDimensions = createD1Env([
      [{ browser: "Chrome", views: 1, visitors: 1, sessions: 1 }],
      [],
    ]);

    await expect(
      queryBrowserCrossDimensionFromD1(
        noBrowsers.env,
        siteId,
        window,
        {},
        3,
        3,
        "TRIM(COALESCE(os, ''))",
        "os",
      ),
    ).resolves.toEqual({ columns: [], rows: [], totalVisitors: 0 });
    await expect(
      queryBrowserCrossDimensionFromD1(
        noDimensions.env,
        siteId,
        window,
        {},
        3,
        3,
        "TRIM(COALESCE(os, ''))",
        "os",
      ),
    ).resolves.toEqual({ columns: [], rows: [], totalVisitors: 0 });

    expect(noBrowsers.calls).toHaveLength(1);
    expect(noDimensions.calls).toHaveLength(2);
  });

  it("queries browser cross breakdown dimensions in parallel", async () => {
    const { env, calls } = createD1Env([
      [{ browser: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [{ browser: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [{ dimension: "Windows", views: 5, visitors: 3, sessions: 2 }],
      [{ dimension: "desktop", views: 5, visitors: 3, sessions: 2 }],
      [
        {
          browser: "Chrome",
          dimension: "Windows",
          views: 5,
          visitors: 3,
          sessions: 2,
        },
      ],
      [
        {
          browser: "Chrome",
          dimension: "desktop",
          views: 5,
          visitors: 3,
          sessions: 2,
        },
      ],
    ]);

    const result = await queryBrowserCrossBreakdownFromD1(
      env,
      siteId,
      window,
      {},
      1,
      2,
      3,
    );

    expect(result.operatingSystem.columns[0]).toMatchObject({
      key: "windows",
      label: "Windows",
    });
    expect(result.deviceType.columns[0]).toMatchObject({
      key: "desktop",
      label: "desktop",
    });
    expect(calls[2].sql).toContain("TRIM(COALESCE(os, ''))");
    expect(calls[3].sql).toContain("TRIM(COALESCE(device_type, ''))");
    expect(calls[2].bindings.at(-1)).toBe(2);
    expect(calls[3].bindings.at(-1)).toBe(3);
  });

  it("maps client cross dimensions with unknown and other buckets", async () => {
    const { env } = createD1Env([
      [
        { primaryValue: "Chrome", views: 10, visitors: 8, sessions: 5 },
        { primaryValue: "Safari", views: 7, visitors: 4, sessions: 4 },
        { primaryValue: "Edge", views: 5, visitors: 3, sessions: 3 },
      ],
      [
        { secondaryValue: "desktop", views: 8, visitors: 7, sessions: 5 },
        { secondaryValue: "", views: 2, visitors: 2, sessions: 2 },
      ],
      [
        {
          primaryValue: "Chrome",
          secondaryValue: "desktop",
          views: 4,
          visitors: 4,
          sessions: 3,
        },
        {
          primaryValue: "Chrome",
          secondaryValue: CLIENT_CROSS_UNKNOWN_TOKEN,
          views: 1,
          visitors: 1,
          sessions: 1,
        },
        {
          primaryValue: "Chrome",
          secondaryValue: CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
          views: 2,
          visitors: 2,
          sessions: 2,
        },
        {
          primaryValue: "Safari",
          secondaryValue: "desktop",
          views: 3,
          visitors: 3,
          sessions: 2,
        },
        {
          primaryValue: CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
          secondaryValue: "desktop",
          views: 2,
          visitors: 2,
          sessions: 1,
        },
        {
          primaryValue: CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
          secondaryValue: CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
          views: 1,
          visitors: 1,
          sessions: 1,
        },
      ],
    ]);

    const result = await queryCrossDimensionFromD1(
      env,
      siteId,
      window,
      {},
      3,
      2,
      clientDimensionDefinition("browser"),
      clientDimensionDefinition("deviceType"),
    );

    expect(result.columns).toEqual([
      { key: "desktop", label: "desktop", views: 8, visitors: 7, sessions: 5 },
      {
        key: "unknown",
        label: "Unknown",
        views: 2,
        visitors: 2,
        sessions: 2,
        isUnknown: true,
      },
      {
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: 3,
        visitors: 3,
        sessions: 3,
        isOther: true,
      },
    ]);
    expect(result.rows.map((row) => row.key)).toEqual([
      "chrome",
      "safari",
      "edge",
      "other",
    ]);
    expect(result.rows[0].cells).toEqual([
      { key: "desktop", label: "desktop", views: 4, visitors: 4, sessions: 3 },
      {
        key: "unknown",
        label: "Unknown",
        views: 1,
        visitors: 1,
        sessions: 1,
        isUnknown: true,
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
    expect(result.rows[2]).toMatchObject({
      key: "edge",
      label: "Edge",
      views: 5,
      visitors: 3,
      sessions: 3,
    });
    expect(result.rows[3]).toMatchObject({
      key: "other",
      label: SHARE_TREND_OTHER_LABEL,
      views: 3,
      visitors: 3,
      sessions: 2,
      isOther: true,
    });
    expect(result.totalVisitors).toBe(16);
  });

  it("returns empty client cross dimensions when top buckets are missing", async () => {
    const noPrimary = createD1Env([[]]);
    const noSecondary = createD1Env([
      [{ primaryValue: "Chrome", views: 1, visitors: 1, sessions: 1 }],
      [],
    ]);

    await expect(
      queryCrossDimensionFromD1(
        noPrimary.env,
        siteId,
        window,
        {},
        3,
        3,
        clientDimensionDefinition("browser"),
        clientDimensionDefinition("deviceType"),
      ),
    ).resolves.toEqual({ columns: [], rows: [], totalVisitors: 0 });
    await expect(
      queryCrossDimensionFromD1(
        noSecondary.env,
        siteId,
        window,
        {},
        3,
        3,
        clientDimensionDefinition("browser"),
        clientDimensionDefinition("deviceType"),
      ),
    ).resolves.toEqual({ columns: [], rows: [], totalVisitors: 0 });

    expect(noPrimary.calls).toHaveLength(1);
    expect(noSecondary.calls).toHaveLength(2);
  });

  it("filters invalid client cross pair rows and drops zero-visitor fallback rows", async () => {
    const { env } = createD1Env([
      [
        { primaryValue: "desktop", views: 8, visitors: 5, sessions: 4 },
        { primaryValue: "mobile", views: 2, visitors: 1, sessions: 1 },
      ],
      [{ secondaryValue: "Chrome", views: 8, visitors: 5, sessions: 4 }],
      [
        {
          primaryValue: "desktop",
          secondaryValue: "Chrome",
          views: 8,
          visitors: 5,
          sessions: 4,
        },
        {
          primaryValue: "",
          secondaryValue: "Chrome",
          views: 2,
          visitors: 2,
          sessions: 2,
        },
        {
          primaryValue: "desktop",
          secondaryValue: "",
          views: 2,
          visitors: 2,
          sessions: 2,
        },
        {
          primaryValue: "mobile",
          secondaryValue: "Chrome",
          views: 2,
          visitors: 0,
          sessions: 0,
        },
      ],
    ]);

    await expect(
      queryCrossDimensionFromD1(
        env,
        siteId,
        window,
        {},
        2,
        1,
        clientDimensionDefinition("deviceType"),
        clientDimensionDefinition("browser"),
      ),
    ).resolves.toMatchObject({
      columns: [{ key: "chrome", label: "Chrome" }],
      rows: [
        {
          key: "desktop",
          label: "desktop",
          views: 8,
          visitors: 5,
          sessions: 4,
        },
        {
          key: "mobile",
          label: "mobile",
          views: 2,
          visitors: 1,
          sessions: 1,
        },
      ],
      totalVisitors: 6,
    });
  });

  it("adds a synthetic other trend series when only bucket rows contain other", async () => {
    const { env } = createD1Env([
      [{ label: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [{ label: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [
        { bucket: 0, label: "Chrome", views: 3, visitors: 2, sessions: 1 },
        {
          bucket: 1,
          label: SHARE_TREND_OTHER_TOKEN,
          views: 2,
          visitors: 1,
          sessions: 1,
        },
      ],
    ]);

    const result = await queryShareTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      {},
      3,
      "TRIM(COALESCE(browser, ''))",
      "browser",
    );

    expect(result.series).toEqual([
      { key: "chrome", label: "Chrome", views: 5, visitors: 3, sessions: 2 },
      {
        key: SHARE_TREND_OTHER_KEY,
        label: SHARE_TREND_OTHER_LABEL,
        views: 0,
        visitors: 0,
        sessions: 0,
        isOther: true,
      },
    ]);
    expect(result.data[0].visitorsBySeries).toEqual({ chrome: 2, other: 0 });
    expect(result.data[1].visitorsBySeries).toEqual({ chrome: 0, other: 1 });
  });

  it("maps share trend top labels, other series, ignored buckets, and empty points", async () => {
    const { env, calls } = createD1Env([
      [
        { label: "Chrome", views: 10, visitors: 5, sessions: 4 },
        { label: "Safari", views: 4, visitors: 2, sessions: 2 },
        { label: "", views: 9, visitors: 9, sessions: 9 },
        { label: "Ignored", views: 9, visitors: 0, sessions: 0 },
      ],
      [
        { label: "Chrome", views: 10, visitors: 5, sessions: 4 },
        {
          label: SHARE_TREND_OTHER_TOKEN,
          views: 4,
          visitors: 2,
          sessions: 2,
        },
      ],
      [
        { bucket: 0, label: "Chrome", views: 5, visitors: 3, sessions: 2 },
        {
          bucket: 0,
          label: SHARE_TREND_OTHER_TOKEN,
          views: 4,
          visitors: 2,
          sessions: 2,
        },
        { bucket: 1, label: "Missing", views: 9, visitors: 9, sessions: 9 },
      ],
    ]);

    const result = await queryShareTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      {},
      99,
      "TRIM(COALESCE(browser, ''))",
      "browser",
    );

    expect(result.series).toEqual([
      { key: "chrome", label: "Chrome", views: 10, visitors: 5, sessions: 4 },
      {
        key: SHARE_TREND_OTHER_KEY,
        label: SHARE_TREND_OTHER_LABEL,
        views: 4,
        visitors: 2,
        sessions: 2,
        isOther: true,
      },
    ]);
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toMatchObject({
      bucket: 0,
      totalVisitors: 5,
      visitorsBySeries: { chrome: 3, other: 2 },
    });
    expect(result.data[1]).toMatchObject({
      bucket: 1,
      totalVisitors: 0,
      visitorsBySeries: { chrome: 0, other: 0 },
    });
    expect(result.data[2]).toMatchObject({
      bucket: 2,
      totalVisitors: 0,
      visitorsBySeries: { chrome: 0, other: 0 },
    });
    expect(calls[0].bindings.at(-1)).toBe(12);
    expect(calls[1].bindings).toEqual([...visitBindings(), "Chrome", "Safari"]);
  });

  it("returns no share trend data when selected top labels have no series rows", async () => {
    const { env } = createD1Env([
      [{ label: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [{ label: "Firefox", views: 4, visitors: 2, sessions: 2 }],
      [{ bucket: 0, label: "Firefox", views: 4, visitors: 2, sessions: 2 }],
    ]);

    await expect(
      queryShareTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        {},
        3,
        "TRIM(COALESCE(browser, ''))",
        "browser",
      ),
    ).resolves.toEqual({ series: [], data: [] });
  });

  it("uses other assignment when no top share trend labels are selected", async () => {
    const { env, calls } = createD1Env([
      [
        { label: "", views: 9, visitors: 9, sessions: 9 },
        { label: "Ignored", views: 9, visitors: 0, sessions: 0 },
      ],
      [
        {
          label: SHARE_TREND_OTHER_TOKEN,
          views: 3,
          visitors: 2,
          sessions: 1,
        },
      ],
      [
        {
          bucket: 0,
          label: SHARE_TREND_OTHER_TOKEN,
          views: 3,
          visitors: 2,
          sessions: 1,
        },
      ],
    ]);

    await expect(
      queryShareTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        {},
        0,
        "TRIM(COALESCE(browser, ''))",
        "browser",
      ),
    ).resolves.toMatchObject({
      series: [
        {
          key: SHARE_TREND_OTHER_KEY,
          label: SHARE_TREND_OTHER_LABEL,
          views: 3,
          visitors: 2,
          sessions: 1,
          isOther: true,
        },
      ],
    });
    expect(calls[0].bindings.at(-1)).toBe(1);
    expect(calls[1].sql).toContain(`'${SHARE_TREND_OTHER_TOKEN}' AS label`);
    expect(calls[1].bindings).toEqual(visitBindings());
  });

  it("returns no share trend data when all series rows are filtered out", async () => {
    const { env } = createD1Env([
      [{ label: "Chrome", views: 5, visitors: 3, sessions: 2 }],
      [
        { label: "", views: 5, visitors: 3, sessions: 2 },
        { label: "Chrome", views: 5, visitors: 0, sessions: 2 },
      ],
    ]);

    await expect(
      queryShareTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        {},
        3,
        "TRIM(COALESCE(browser, ''))",
        "browser",
      ),
    ).resolves.toEqual({ series: [], data: [] });
  });

  it("wires technology trend wrappers to their dimension expressions", async () => {
    const browserEnv = createD1Env([[], []]);
    const engineEnv = createD1Env([[], []]);
    const clientEnv = createD1Env([[], []]);
    const utmEnv = createD1Env([[], []]);
    const referrerEnv = createD1Env([[], []]);

    await expect(
      queryBrowserTrendFromD1(browserEnv.env, siteId, window, "hour", {}, 3),
    ).resolves.toEqual({ series: [], data: [] });
    await expect(
      queryBrowserEngineTrendFromD1(
        engineEnv.env,
        siteId,
        window,
        "hour",
        {},
        3,
      ),
    ).resolves.toEqual({ series: [], data: [] });
    await expect(
      queryClientDimensionTrendFromD1(
        clientEnv.env,
        siteId,
        window,
        "hour",
        {},
        "deviceType",
        3,
      ),
    ).resolves.toEqual({ series: [], data: [] });
    await expect(
      queryUtmDimensionTrendFromD1(
        utmEnv.env,
        siteId,
        window,
        "hour",
        {},
        "source",
        3,
      ),
    ).resolves.toEqual({ series: [], data: [] });
    await expect(
      queryReferrerTrendFromD1(referrerEnv.env, siteId, window, "hour", {}, 3),
    ).resolves.toEqual({ series: [], data: [] });

    expect(browserEnv.calls[0].sql).toContain("TRIM(COALESCE(browser, ''))");
    expect(engineEnv.calls[0].sql).toContain("CASE");
    expect(engineEnv.calls[0].sql).toContain("WebKit");
    expect(clientEnv.calls[0].sql).toContain("TRIM(COALESCE(device_type, ''))");
    expect(utmEnv.calls[0].sql).toContain("TRIM(COALESCE(utm_source, ''))");
    expect(referrerEnv.calls[0].sql).toContain(
      "TRIM(COALESCE(referrer_host, ''))",
    );
  });

  it("defaults nullable browser version rows while filtering empty browser buckets", async () => {
    const { env } = createD1Env([
      [
        { browser: null, views: 9, visitors: 9, sessions: 9 },
        { browser: " Chrome ", views: null, visitors: "4", sessions: null },
      ],
      [
        {
          browser: "Chrome",
          version: null,
          views: null,
          visitors: "2",
          sessions: null,
        },
      ],
    ]);

    await expect(
      queryBrowserVersionBreakdownFromD1(env, siteId, window, {}, 3, 2),
    ).resolves.toEqual([
      {
        browser: "Chrome",
        views: 0,
        visitors: 4,
        sessions: 0,
        versions: [
          {
            key: "version",
            label: "",
            views: 0,
            visitors: 2,
            sessions: 0,
          },
        ],
      },
    ]);
  });

  it("defaults nullable browser cross rows and filters invalid nullable pairs", async () => {
    const { env } = createD1Env([
      [
        { browser: null, views: 9, visitors: 9, sessions: 9 },
        { browser: " Chrome ", views: null, visitors: "4", sessions: null },
      ],
      [{ dimension: null, views: null, visitors: "3", sessions: null }],
      [
        {
          browser: "Chrome",
          dimension: BROWSER_CROSS_UNKNOWN_TOKEN,
          views: null,
          visitors: "2",
          sessions: null,
        },
        {
          browser: null,
          dimension: BROWSER_CROSS_UNKNOWN_TOKEN,
          views: 9,
          visitors: 9,
          sessions: 9,
        },
        {
          browser: "Chrome",
          dimension: null,
          views: 9,
          visitors: 9,
          sessions: 9,
        },
      ],
    ]);

    await expect(
      queryBrowserCrossDimensionFromD1(
        env,
        siteId,
        window,
        {},
        3,
        3,
        "TRIM(COALESCE(os, ''))",
        "os",
      ),
    ).resolves.toEqual({
      columns: [
        {
          key: "unknown",
          label: "Unknown",
          views: 0,
          visitors: 3,
          sessions: 0,
          isUnknown: true,
        },
      ],
      rows: [
        {
          key: "chrome",
          label: "Chrome",
          views: 0,
          visitors: 2,
          sessions: 0,
          cells: [
            {
              key: "unknown",
              label: "Unknown",
              views: 0,
              visitors: 2,
              sessions: 0,
              isUnknown: true,
            },
          ],
        },
      ],
      totalVisitors: 2,
    });
  });

  it("defaults nullable client cross rows and filters invalid nullable pairs", async () => {
    const { env } = createD1Env([
      [
        { primaryValue: null, views: 9, visitors: 9, sessions: 9 },
        {
          primaryValue: " Chrome ",
          views: null,
          visitors: "4",
          sessions: null,
        },
      ],
      [{ secondaryValue: null, views: null, visitors: "3", sessions: null }],
      [
        {
          primaryValue: "Chrome",
          secondaryValue: CLIENT_CROSS_UNKNOWN_TOKEN,
          views: null,
          visitors: "2",
          sessions: null,
        },
        {
          primaryValue: null,
          secondaryValue: CLIENT_CROSS_UNKNOWN_TOKEN,
          views: 9,
          visitors: 9,
          sessions: 9,
        },
        {
          primaryValue: "Chrome",
          secondaryValue: null,
          views: 9,
          visitors: 9,
          sessions: 9,
        },
      ],
    ]);

    await expect(
      queryCrossDimensionFromD1(
        env,
        siteId,
        window,
        {},
        3,
        3,
        clientDimensionDefinition("browser"),
        clientDimensionDefinition("deviceType"),
      ),
    ).resolves.toEqual({
      columns: [
        {
          key: "unknown",
          label: "Unknown",
          views: 0,
          visitors: 3,
          sessions: 0,
          isUnknown: true,
        },
      ],
      rows: [
        {
          key: "chrome",
          label: "Chrome",
          views: 0,
          visitors: 2,
          sessions: 0,
          cells: [
            {
              key: "unknown",
              label: "Unknown",
              views: 0,
              visitors: 2,
              sessions: 0,
              isUnknown: true,
            },
          ],
        },
      ],
      totalVisitors: 2,
    });
  });

  it("defaults nullable share trend rows and bucket metrics", async () => {
    const { env } = createD1Env([
      [
        { label: null, views: 9, visitors: 9, sessions: 9 },
        { label: " Chrome ", views: null, visitors: "4", sessions: null },
      ],
      [
        { label: null, views: 9, visitors: 9, sessions: 9 },
        { label: "Chrome", views: null, visitors: "3", sessions: null },
      ],
      [
        {
          bucket: null,
          label: "Chrome",
          views: null,
          visitors: "2",
          sessions: null,
        },
        { bucket: 1, label: null, views: 9, visitors: 9, sessions: 9 },
      ],
    ]);

    await expect(
      queryShareTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        {},
        3,
        "TRIM(COALESCE(browser, ''))",
        "browser",
      ),
    ).resolves.toMatchObject({
      series: [
        {
          key: "chrome",
          label: "Chrome",
          views: 0,
          visitors: 3,
          sessions: 0,
        },
      ],
      data: [
        {
          bucket: 0,
          totalVisitors: 2,
          visitorsBySeries: { chrome: 2 },
        },
        {
          bucket: 1,
          totalVisitors: 0,
          visitorsBySeries: { chrome: 0 },
        },
        {
          bucket: 2,
          totalVisitors: 0,
          visitorsBySeries: { chrome: 0 },
        },
      ],
    });
  });

  it("defaults nullable radar metrics while filtering invalid rows", async () => {
    const browserEnv = createD1Env([
      [
        { browser: " Chrome ", visitors: "3" },
        { browser: "", visitors: 10 },
        { browser: "No visitors", visitors: 0 },
      ],
    ]);
    const referrerEnv = createD1Env([
      [
        { referrer: null, visitors: "2" },
        { referrer: "news.example", visitors: 0 },
      ],
    ]);

    await expect(
      queryBrowserRadarFromD1(browserEnv.env, siteId, window, {
        browser: "Chrome",
      }),
    ).resolves.toEqual([
      {
        browser: "Chrome",
        sessions: 0,
        bounces: 0,
        avgDurationMs: 0,
        avgDepth: 0,
        visitors: 3,
        returningVisitors: 0,
        avgFrequency: 0,
        trafficShare: 0,
      },
    ]);
    await expect(
      queryReferrerRadarFromD1(referrerEnv.env, siteId, window, {}, 5),
    ).resolves.toEqual([
      {
        referrer: "",
        sessions: 0,
        bounces: 0,
        avgDurationMs: 0,
        avgDepth: 0,
        visitors: 2,
        returningVisitors: 0,
        avgFrequency: 0,
        trafficShare: 0,
      },
    ]);

    expect(browserEnv.calls[0].bindings).toEqual([
      ...visitBindings(),
      "Chrome",
    ]);
    expect(referrerEnv.calls[0].bindings).toEqual([...visitBindings(), 5]);
  });
});
