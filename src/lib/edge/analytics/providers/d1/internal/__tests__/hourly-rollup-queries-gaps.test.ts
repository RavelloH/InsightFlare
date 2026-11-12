import { describe, expect, it, vi } from "vitest";

import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
  queryTrendForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import type { Env } from "@/lib/edge/types";

const HOUR = 60 * 60 * 1000;

function makeEnv(...batches: unknown[][]): {
  env: Env;
  all: ReturnType<typeof vi.fn>;
} {
  const all = vi.fn();
  for (const results of batches) all.mockResolvedValueOnce({ results });
  all.mockResolvedValue({ results: [] });
  const db = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    all,
    first: vi.fn(),
    run: vi.fn(),
    batch: vi.fn(),
  };
  return { env: { DB: db } as unknown as Env, all };
}

function rollupRow(overrides: Record<string, unknown>) {
  return {
    siteId: "site-1",
    hourBucket: 1,
    views: 0,
    durationMsSum: 0,
    durationMsCount: 0,
    perfTtfbSum: 0,
    perfTtfbCount: 0,
    perfFcpSum: 0,
    perfFcpCount: 0,
    perfLcpSum: 0,
    perfLcpCount: 0,
    perfClsSum: 0,
    perfClsCount: 0,
    perfInpSum: 0,
    perfInpCount: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    visitorSetJson: "[]",
    sessionCountsJson: "[]",
    ...overrides,
  };
}

function detailRow(overrides: Record<string, unknown>) {
  return {
    siteId: "site-1",
    startedAt: 2 * HOUR + 10,
    visitorId: "v",
    sessionId: "s",
    durationMs: null,
    perfTtfbMs: null,
    perfFcpMs: null,
    perfLcpMs: null,
    perfCls: null,
    perfInpMs: null,
    ...overrides,
  };
}

const ALIGNED = {
  startMs: HOUR,
  endExclusiveMs: 3 * HOUR,
  nowMs: 10 * HOUR,
  timeZone: "UTC",
} as const;

describe("hourly rollup stored JSON tolerance", () => {
  it("ignores malformed visitor and session payloads while keeping valid entries", async () => {
    const { env } = makeEnv(
      [{ siteId: "site-1", aggregatedUntilHour: 10 }],
      [
        rollupRow({
          hourBucket: 2,
          views: 3,
          durationMsSum: 30,
          durationMsCount: 3,
          visitorSetJson: '["v1"," ","v2"]',
          sessionCountsJson:
            '[["s1",2],["s2",1],["",3],["s3",0],["s4","abc"],"bad",["s5"]]',
        }),
        rollupRow({
          hourBucket: 2,
          visitorSetJson: '{"a":1}',
          sessionCountsJson: '{"x":1}',
        }),
        rollupRow({
          hourBucket: 1,
          visitorSetJson: "not json",
          sessionCountsJson: "also not json",
        }),
      ],
    );

    const overview = await queryOverviewForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      ALIGNED,
    );

    expect(overview.get("site-1")).toEqual({
      views: 3,
      sessions: 2,
      visitors: 2,
      bounces: 1,
      totalDuration: 30,
      durationViews: 3,
    });
  });

  it("skips aggregation states that were not requested or are not finite", async () => {
    const { env, all } = makeEnv([
      { siteId: "other-site", aggregatedUntilHour: 10 },
      { siteId: "site-1", aggregatedUntilHour: "not-a-number" },
    ]);

    const overview = await queryOverviewForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      ALIGNED,
    );

    expect(overview.size).toBe(0);
    expect(all).toHaveBeenCalledTimes(1);
  });
});

describe("hourly rollup detail fallbacks", () => {
  // Rollups cover hour 1 only; hour 2 comes from detail visit rows.
  function suffixEnv() {
    return makeEnv(
      [{ siteId: "site-1", aggregatedUntilHour: 1 }],
      [
        rollupRow({
          hourBucket: 1,
          views: 2,
          visitorSetJson: '["rv"]',
          sessionCountsJson: '[["rs",1],["s9",2]]',
        }),
      ],
      [
        detailRow({
          startedAt: 2 * HOUR + 10,
          visitorId: "v9",
          sessionId: "s9",
          durationMs: 50,
          perfTtfbMs: 1,
          perfFcpMs: 2,
          perfLcpMs: 3,
          perfCls: 0.1,
          perfInpMs: 4,
        }),
        detailRow({
          startedAt: 2 * HOUR + 20,
          visitorId: "  ",
          sessionId: "  ",
          durationMs: -5,
          perfTtfbMs: Number.NaN,
          perfCls: null,
        }),
        detailRow({
          startedAt: 2 * HOUR + 30,
          visitorId: "v9",
          sessionId: "s9",
          durationMs: 0,
        }),
        // Outside every trend bucket, so only the overview sees it.
        detailRow({ startedAt: 99 * HOUR, visitorId: "far", sessionId: "far" }),
      ],
    );
  }

  it("merges detail rows into overview and hourly trend buckets", async () => {
    const { env } = suffixEnv();

    const result = await queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      ALIGNED,
      "hour",
    );

    expect(result.overview.get("site-1")).toEqual({
      views: 6,
      sessions: 3,
      visitors: 3,
      bounces: 2,
      totalDuration: 50,
      durationViews: 2,
    });
    const rows = result.trend!.get("site-1")!;
    expect(rows.map((row) => row.bucket)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ views: 2, visitors: 1, sessions: 2 });
    expect(rows[1]).toMatchObject({
      views: 3,
      visitors: 1,
      totalDuration: 50,
      durationViews: 2,
    });
  });

  it("builds trend-only rows and ignores rollups or details outside the buckets", async () => {
    const { env } = makeEnv(
      [{ siteId: "site-1", aggregatedUntilHour: 1 }],
      [rollupRow({ hourBucket: 1, views: 1, sessionCountsJson: '[["a",1]]' })],
      [
        detailRow({ startedAt: 2 * HOUR + 1, sessionId: "b" }),
        detailRow({ startedAt: 50 * HOUR, sessionId: "c" }),
      ],
    );

    const trend = await queryTrendForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      ALIGNED,
      "hour",
    );

    const rows = trend!.get("site-1")!;
    expect(rows.map((row) => [row.bucket, row.views, row.sessions])).toEqual([
      [0, 1, 1],
      [1, 1, 1],
    ]);
  });

  it("accumulates overview detail rows for the prefix and suffix windows", async () => {
    const { env, all } = makeEnv(
      [{ siteId: "site-1", aggregatedUntilHour: 1 }],
      [rollupRow({ hourBucket: 1, views: 4 })],
      [
        detailRow({
          startedAt: 100,
          visitorId: "p",
          sessionId: "sp",
          durationMs: 7,
          perfFcpMs: 1,
          perfLcpMs: 1,
          perfCls: 1,
          perfInpMs: 1,
        }),
      ],
      [detailRow({ startedAt: 2 * HOUR + 5, visitorId: "q", sessionId: "sq" })],
    );

    const overview = await queryOverviewForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      {
        startMs: 50,
        endExclusiveMs: 2 * HOUR + 50,
        nowMs: 10 * HOUR,
        timeZone: "UTC",
      },
    );

    expect(all).toHaveBeenCalledTimes(4);
    expect(overview.get("site-1")).toEqual({
      views: 6,
      sessions: 2,
      visitors: 2,
      bounces: 2,
      totalDuration: 7,
      durationViews: 1,
    });
  });
});
