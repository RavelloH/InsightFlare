import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries",
  () => ({ queryOverviewForSitesFromHourlyRollupsPartial: vi.fn() }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/overview", () => ({
  queryOverviewFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/overview-reader", () => ({
  createOverviewReader: vi.fn(),
  toQueryTime: vi.fn(
    (window: {
      startMs: number;
      endExclusiveMs: number;
      nowMs: number;
      timeZone: string;
    }) => ({
      range: {
        startMs: window.startMs,
        endExclusiveMs: window.endExclusiveMs,
      },
      reportingTimeZone: window.timeZone,
      capturedAtMs: window.nowMs,
    }),
  ),
}));

import { queryOverviewForSitesFromHourlyRollupsPartial } from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import { queryOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";

const env = {} as never;
const input = {
  env,
  teamId: "team-1",
  allowedSiteIds: ["site-1"],
  window: {
    startMs: 0,
    endExclusiveMs: 1,
    nowMs: 1,
    timeZone: "UTC",
  },
  filters: { version: 1 as const, root: null },
};

describe("team overview runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs only authorized sites through the typed overview reader and merges provenance", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
    ] as never);
    vi.mocked(createOverviewReader).mockImplementation((_, siteId) => ({
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: siteId === "site-1" ? 4 : 99,
          sessions: 2,
          visitors: 2,
          bounces: 1,
          totalDurationMs: 100,
          durationViews: 4,
        },
        source: "rollup",
        approximateVisitors: false,
      }),
      readTrend: vi.fn(),
    }));

    await expect(readTeamOverview(input)).resolves.toEqual({
      data: {
        views: 4,
        sessions: 2,
        visitors: 2,
        bounces: 1,
        totalDurationMs: 100,
        durationViews: 4,
      },
      source: "rollup",
      approximateVisitors: false,
    });
    expect(createOverviewReader).toHaveBeenCalledTimes(1);
    expect(createOverviewReader).toHaveBeenCalledWith(env, "site-1");
  });

  it("batches only authorized sites and falls back directly for missing rollups", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
      { id: "site-3" },
    ] as never);
    const a = {
      views: 8,
      sessions: 4,
      visitors: 3,
      bounces: 2,
      totalDuration: 70,
      durationViews: 6,
    };
    const b = {
      views: 2,
      sessions: 1,
      visitors: 1,
      bounces: 1,
      totalDuration: 10,
      durationViews: 2,
    };
    vi.mocked(queryOverviewForSitesFromHourlyRollupsPartial).mockResolvedValue(
      new Map([["site-1", a]]),
    );
    vi.mocked(queryOverviewFromD1).mockResolvedValue(b);
    await expect(
      readTeamOverview({ ...input, allowedSiteIds: ["site-1", "site-2"] }),
    ).resolves.toEqual({
      data: {
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 3,
        totalDurationMs: 80,
        durationViews: 8,
      },
      source: "mixed",
      approximateVisitors: false,
    });
    expect(
      queryOverviewForSitesFromHourlyRollupsPartial,
    ).toHaveBeenCalledExactlyOnceWith(env, ["site-1", "site-2"], input.window);
    expect(queryOverviewFromD1).toHaveBeenCalledExactlyOnceWith(
      env,
      "site-2",
      input.window,
      input.filters,
    );
    expect(createOverviewReader).not.toHaveBeenCalled();
  });
  it("returns zero metrics without any accessible site", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([] as never);
    await expect(readTeamOverview(input)).resolves.toMatchObject({
      data: { views: 0, sessions: 0 },
      source: "raw",
    });
    expect(createOverviewReader).not.toHaveBeenCalled();

    expect(listTeamSites).toHaveBeenCalledTimes(1);
  });

  it("reports mixed provenance and passes canonical filters", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
    ] as never);
    vi.mocked(createOverviewReader).mockImplementation((_, siteId) => ({
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 1,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 10,
          durationViews: 1,
        },
        source: siteId === "site-1" ? "raw" : "rollup",
        approximateVisitors: siteId === "site-2",
      }),
      readTrend: vi.fn(),
    }));
    await expect(
      readTeamOverview({
        ...input,
        allowedSiteIds: undefined,
        filters: {
          version: 1 as const,
          root: {
            kind: "condition" as const,
            target: { kind: "field" as const, field: "page.path" as never },
            operator: "eq" as const,
            value: "/",
          },
        },
      }),
    ).resolves.toMatchObject({ source: "mixed", approximateVisitors: true });

    await expect(
      readTeamOverview({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "forbidden.field" as never },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).resolves.toMatchObject({ data: { views: 1 } });
  });
});
