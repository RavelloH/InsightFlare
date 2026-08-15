import { describe, expect, it, vi } from "vitest";

import {
  hasDashboardFilters,
  queryOverviewForSitesFromHourlyRollups,
  queryTrendForSitesFromHourlyRollups,
} from "@/lib/edge/hourly-rollup";
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

describe("hasDashboardFilters", () => {
  it("returns false for empty filters", () => {
    expect(hasDashboardFilters({})).toBe(false);
  });

  it("returns false when all values are undefined/null/empty", () => {
    expect(
      hasDashboardFilters({
        country: undefined,
        browser: null as unknown as undefined,
        device: "",
        path: undefined,
      }),
    ).toBe(false);
  });

  it("returns true when a string filter is set", () => {
    expect(hasDashboardFilters({ country: "US" })).toBe(true);
  });

  it("returns true when a path filter is set", () => {
    expect(hasDashboardFilters({ path: "/home" })).toBe(true);
  });

  it("returns true when a device filter is set", () => {
    expect(hasDashboardFilters({ device: "desktop" })).toBe(true);
  });
});

describe("queryOverviewForSitesFromHourlyRollups", () => {
  it("returns empty Map for empty siteIds", async () => {
    const env = { DB: makeDbMock() } as unknown as Env;
    const result = await queryOverviewForSitesFromHourlyRollups(env, [], {
      fromMs: 1000,
      toMs: 2000,
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
      { fromMs: 1000, toMs: 2000, nowMs: 3000, timeZone: "UTC" },
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
      fromMs: 60 * 60 * 1000,
      toMs: 2 * 60 * 60 * 1000 - 1,
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

    // Window fromMs=100, toMs=200 is way before hour 10 (which is 10*3600000=36000000)
    const result = await queryOverviewForSitesFromHourlyRollups(
      env,
      ["site-1"],
      { fromMs: 100, toMs: 200, nowMs: 3000, timeZone: "UTC" },
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
      { fromMs: 1000, toMs: 2000, nowMs: 3000, timeZone: "UTC" },
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
      { fromMs: 1000, toMs: 2000, nowMs: 3000, timeZone: "UTC" },
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
      { fromMs: 100, toMs: 200, nowMs: 3000, timeZone: "UTC" },
      "hour",
    );
    expect(result).toBeNull();
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
      { fromMs: 1000, toMs: 2000, nowMs: 3000, timeZone: "UTC" },
    );
    expect(result).toBeNull();
  });
});
