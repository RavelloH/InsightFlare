import { describe, expect, it, vi } from "vitest";

import {
  hasFilterDocument,
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollups,
  queryTrendForSitesFromHourlyRollups,
} from "@/lib/edge/hourly-rollup";
import {
  analyticsFilterRegistry,
  EMPTY_FILTER_DOCUMENT,
  hasFilters,
  normalizeFilterDocument,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

function makeDbMock(firstResult: unknown = null, allResults: unknown[] = []) {
  return {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: allResults }),
    run: vi.fn(),
    batch: vi.fn(),
  };
}

function document(field: string, value: string) {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field },
        operator: "eq",
        value,
      },
    },
    analyticsFilterRegistry,
  );
}

describe("hasFilters", () => {
  it("returns false for empty filters", () => {
    expect(hasFilters(EMPTY_FILTER_DOCUMENT)).toBe(false);
  });

  it("returns true for effective typed filters", () => {
    expect(hasFilters(document("geo.country", "US"))).toBe(true);
    expect(hasFilters(document("page.path", "/home"))).toBe(true);
    expect(hasFilters(document("client.deviceType", "desktop"))).toBe(true);
  });
});

describe("hasFilterDocument", () => {
  it("does not treat the document version as an active filter", () => {
    expect(hasFilterDocument(EMPTY_FILTER_DOCUMENT)).toBe(false);
    expect(hasFilterDocument(document("geo.country", "US"))).toBe(true);
  });
});

describe("queryOverviewForSitesFromHourlyRollups", () => {
  it("returns empty Map for empty siteIds", async () => {
    const env = { DB: makeDbMock() } as unknown as Env;
    const result = await queryOverviewForSitesFromHourlyRollups(env, [], {
      startMs: 1000,
      endExclusiveMs: 2000,
      nowMs: 3000,
      timeZone: "UTC",
    });
    expect(result).toEqual(new Map());
  });

  it("returns null when aggregation states are incomplete", async () => {
    const db = makeDbMock();
    // First call: queryAggregationStates - returns empty (no state for site)
    db.all.mockResolvedValueOnce({ results: [] });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewForSitesFromHourlyRollups(
      env,
      ["site-1"],
      { startMs: 1000, endExclusiveMs: 2000, nowMs: 3000, timeZone: "UTC" },
    );
    expect(result).toBeNull();
  });

  it("splits rollup reads before D1 reaches 100 bindings", async () => {
    const db = makeDbMock();
    const siteIds = Array.from({ length: 99 }, (_, index) => `site-${index}`);
    db.all
      .mockResolvedValueOnce({
        results: siteIds.map((siteId) => ({
          siteId,
          aggregatedUntilHour: 1,
        })),
      })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewForSitesFromHourlyRollups(env, siteIds, {
      startMs: 60 * 60 * 1000,
      endExclusiveMs: 2 * 60 * 60 * 1000,
      nowMs: 3 * 60 * 60 * 1000,
      timeZone: "UTC",
    });

    expect(result).toHaveLength(99);
    expect(db.bind.mock.calls.map((call) => call.length)).toEqual([99, 100, 3]);
  });

  it("returns null when splitRollupWindow returns null (window before rollup range)", async () => {
    const db = makeDbMock();
    // Aggregation state: site aggregated until hour 10
    db.all.mockResolvedValueOnce({
      results: [{ siteId: "site-1", aggregatedUntilHour: 10 }],
    });
    const env = { DB: db } as unknown as Env;

    // Window [100, 200) is way before hour 10 (which is 10*3600000=36000000).
    const result = await queryOverviewForSitesFromHourlyRollups(
      env,
      ["site-1"],
      { startMs: 100, endExclusiveMs: 200, nowMs: 3000, timeZone: "UTC" },
    );
    expect(result).toBeNull();
  });
});

describe("queryTrendForSitesFromHourlyRollups", () => {
  it("returns empty array for empty siteIds", async () => {
    const env = { DB: makeDbMock() } as unknown as Env;
    const result = await queryTrendForSitesFromHourlyRollups(
      env,
      [],
      { startMs: 1000, endExclusiveMs: 2000, nowMs: 3000, timeZone: "UTC" },
      "day",
    );
    expect(result).toEqual([]);
  });

  it("returns null when aggregation states are incomplete", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValueOnce({ results: [] });
    const env = { DB: db } as unknown as Env;

    const result = await queryTrendForSitesFromHourlyRollups(
      env,
      ["site-1"],
      { startMs: 1000, endExclusiveMs: 2000, nowMs: 3000, timeZone: "UTC" },
      "day",
    );
    expect(result).toBeNull();
  });

  it("returns null when splitRollupWindow returns null", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValueOnce({
      results: [{ siteId: "site-1", aggregatedUntilHour: 10 }],
    });
    const env = { DB: db } as unknown as Env;

    const result = await queryTrendForSitesFromHourlyRollups(
      env,
      ["site-1"],
      { startMs: 100, endExclusiveMs: 200, nowMs: 3000, timeZone: "UTC" },
      "hour",
    );
    expect(result).toBeNull();
  });

  it("keeps wide-window rollup rows within their matching time bucket", async () => {
    const db = makeDbMock();
    db.all
      .mockResolvedValueOnce({
        results: [{ siteId: "site-1", aggregatedUntilHour: 2 }],
      })
      .mockResolvedValueOnce({
        results: [
          {
            siteId: "site-1",
            hourBucket: -1,
            views: 99,
            durationMsSum: 0,
            durationMsCount: 0,
            visitors: 0,
            sessions: 0,
            bounces: 0,
            visitorSetJson: "[]",
            sessionCountsJson: "[]",
          },
          {
            siteId: "site-1",
            hourBucket: 1,
            views: 1,
            durationMsSum: 100,
            durationMsCount: 1,
            visitors: 1,
            sessions: 1,
            bounces: 1,
            visitorSetJson: '["visitor-1"]',
            sessionCountsJson: '[["session-1",1]]',
          },
          {
            siteId: "site-1",
            hourBucket: 3,
            views: 99,
            durationMsSum: 0,
            durationMsCount: 0,
            visitors: 0,
            sessions: 0,
            bounces: 0,
            visitorSetJson: "[]",
            sessionCountsJson: "[]",
          },
        ],
      });
    const env = { DB: db } as unknown as Env;

    await expect(
      queryTrendForSitesFromHourlyRollups(
        env,
        ["site-1"],
        {
          startMs: 0,
          endExclusiveMs: 3 * 60 * 60 * 1000,
          nowMs: 4 * 60 * 60 * 1000,
          timeZone: "UTC",
        },
        "hour",
      ),
    ).resolves.toEqual([
      {
        siteId: "site-1",
        bucket: 1,
        timestampMs: 60 * 60 * 1000,
        views: 1,
        visitors: 1,
        sessions: 1,
        bounces: 1,
        totalDuration: 100,
        durationViews: 1,
      },
    ]);
  });
});

describe("queryOverviewAndTrendForSitesFromHourlyRollupsPartial", () => {
  it("returns empty aggregates for an empty site list", async () => {
    const env = { DB: makeDbMock() } as unknown as Env;

    await expect(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
        env,
        [],
        { startMs: 0, endExclusiveMs: 1, nowMs: 2, timeZone: "UTC" },
        "hour",
      ),
    ).resolves.toEqual({ overview: new Map(), trend: new Map() });
  });

  it("leaves trend unavailable for non-hour-aligned buckets", async () => {
    const db = makeDbMock();
    db.all
      .mockResolvedValueOnce({
        results: [{ siteId: "site-1", aggregatedUntilHour: 1 }],
      })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      {
        startMs: 100,
        endExclusiveMs: 2 * 60 * 60 * 1000 + 100,
        nowMs: 3 * 60 * 60 * 1000,
        timeZone: "UTC",
      },
      "minute",
    );

    expect(result.overview.get("site-1")).toMatchObject({
      views: 0,
      sessions: 0,
      visitors: 0,
    });
    expect(result.trend).toBeNull();
    expect(db.all).toHaveBeenCalledTimes(4);
  });

  it("combines rollups with detail rows around the closed-hour boundary", async () => {
    const hour = 60 * 60 * 1000;
    const db = makeDbMock();
    db.all
      .mockResolvedValueOnce({
        results: [{ siteId: "site-1", aggregatedUntilHour: 1 }],
      })
      .mockResolvedValueOnce({
        results: [
          {
            siteId: "site-1",
            hourBucket: -1,
            views: 0,
            durationMsSum: 0,
            durationMsCount: 0,
            visitorSetJson: "[]",
            sessionCountsJson: "[]",
          },
          {
            siteId: "site-1",
            hourBucket: 1,
            views: 1,
            durationMsSum: 10,
            durationMsCount: 1,
            visitorSetJson: '["rollup-visitor"]',
            sessionCountsJson: '[["rollup-session",1]]',
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            siteId: "site-1",
            startedAt: 100,
            visitorId: "prefix-visitor",
            sessionId: "prefix-session",
            durationMs: 20,
            perfTtfbMs: null,
            perfFcpMs: null,
            perfLcpMs: null,
            perfCls: null,
            perfInpMs: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            siteId: "site-1",
            startedAt: 2 * hour + 100,
            visitorId: "suffix-visitor",
            sessionId: "suffix-session",
            durationMs: 30,
            perfTtfbMs: null,
            perfFcpMs: null,
            perfLcpMs: null,
            perfCls: null,
            perfInpMs: null,
          },
        ],
      });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      {
        startMs: 100,
        endExclusiveMs: 2 * hour + 101,
        nowMs: 3 * hour,
        timeZone: "UTC",
      },
      "hour",
    );

    expect(db.all).toHaveBeenCalledTimes(4);
    expect(result.overview.get("site-1")).toMatchObject({
      views: 3,
      sessions: 3,
      visitors: 3,
      bounces: 3,
      totalDuration: 60,
      durationViews: 3,
    });
    expect(result.trend?.get("site-1")).toHaveLength(3);
  });

  it("shares one rollup read between overview and trend", async () => {
    const db = makeDbMock();
    db.all
      .mockResolvedValueOnce({
        results: [{ siteId: "site-1", aggregatedUntilHour: 2 }],
      })
      .mockResolvedValueOnce({
        results: [
          {
            siteId: "site-1",
            hourBucket: 1,
            views: 2,
            durationMsSum: 100,
            durationMsCount: 1,
            visitors: 1,
            sessions: 1,
            bounces: 1,
            visitorSetJson: '["visitor-1"]',
            sessionCountsJson: '[["session-1",2]]',
          },
        ],
      });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
      env,
      ["site-1"],
      {
        startMs: 0,
        endExclusiveMs: 3 * 60 * 60 * 1000,
        nowMs: 4 * 60 * 60 * 1000,
        timeZone: "UTC",
      },
      "hour",
    );

    expect(db.all).toHaveBeenCalledTimes(2);
    expect(result.overview.get("site-1")).toMatchObject({
      views: 2,
      sessions: 1,
      visitors: 1,
      bounces: 0,
      totalDuration: 100,
      durationViews: 1,
    });
    expect(result.trend?.get("site-1")).toEqual([
      {
        siteId: "site-1",
        bucket: 1,
        timestampMs: 60 * 60 * 1000,
        views: 2,
        visitors: 1,
        sessions: 1,
        bounces: 0,
        totalDuration: 100,
        durationViews: 1,
      },
    ]);
  });
});

describe("queryOverviewForSitesFromHourlyRollups edge cases", () => {
  it("returns null when not all sites have aggregation state", async () => {
    const db = makeDbMock();
    db.all.mockResolvedValueOnce({
      results: [{ siteId: "site-1", aggregatedUntilHour: 10 }],
    });
    const env = { DB: db } as unknown as Env;

    const result = await queryOverviewForSitesFromHourlyRollups(
      env,
      ["site-1", "site-2"],
      { startMs: 1000, endExclusiveMs: 2000, nowMs: 3000, timeZone: "UTC" },
    );
    expect(result).toBeNull();
  });
});
