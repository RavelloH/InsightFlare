import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries",
  () => ({ queryTrendForSitesFromHourlyRollupsPartial: vi.fn() }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/overview", () => ({
  queryTrendFromD1: vi.fn(),
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

import { queryTrendForSitesFromHourlyRollupsPartial } from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";

const input = {
  env: {} as never,
  teamId: "team-1",
  allowedSiteIds: ["site-1", "site-2"],
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  interval: "hour" as const,
  filters: { version: 1 as const, root: null },
};

describe("team timeseries runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges equal buckets across only authorized sites", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
      { id: "site-3" },
    ] as never);
    vi.mocked(createOverviewReader).mockImplementation((_, siteId) => ({
      readOverview: vi.fn(),
      readTrend: vi.fn().mockResolvedValue({
        value: [
          {
            bucket: 0,
            timestampMs: 0,
            views: siteId === "site-1" ? 4 : 6,
            sessions: 1,
            visitors: 1,
            bounces: 0,
            totalDurationMs: 10,
            durationViews: 1,
          },
        ],
        source: siteId === "site-1" ? "raw" : "rollup",
        approximateVisitors: siteId === "site-2",
      }),
    }));
    await expect(
      readTeamTimeseries({
        ...input,
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
    ).resolves.toMatchObject({
      data: { interval: "hour", points: [{ views: 10, sessions: 2 }] },
      source: "mixed",
      approximateVisitors: true,
    });
    expect(createOverviewReader).toHaveBeenCalledTimes(2);
  });

  it("batches authorized trends and preserves complete metrics on raw fallback", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
      { id: "site-3" },
    ] as never);
    const row = {
      bucket: 0,
      timestampMs: 0,
      views: 4,
      sessions: 2,
      visitors: 2,
      bounces: 1,
      totalDuration: 10,
      durationViews: 2,
    };
    vi.mocked(queryTrendForSitesFromHourlyRollupsPartial).mockResolvedValue(
      new Map([["site-1", [{ ...row, siteId: "site-1" }]]]),
    );
    vi.mocked(queryTrendFromD1).mockResolvedValue([
      { ...row, views: 6, sessions: 3 },
    ]);
    await expect(readTeamTimeseries(input)).resolves.toEqual({
      data: {
        interval: "hour",
        points: [
          {
            bucket: 0,
            timestampMs: 0,
            views: 10,
            sessions: 5,
            visitors: 4,
            bounces: 2,
            totalDurationMs: 20,
            durationViews: 4,
          },
        ],
      },
      source: "mixed",
      approximateVisitors: false,
    });
    expect(
      queryTrendForSitesFromHourlyRollupsPartial,
    ).toHaveBeenCalledExactlyOnceWith(
      input.env,
      ["site-1", "site-2"],
      input.window,
      input.interval,
    );
    expect(queryTrendFromD1).toHaveBeenCalledExactlyOnceWith(
      input.env,
      "site-2",
      input.window,
      input.interval,
      input.filters,
    );
    expect(createOverviewReader).not.toHaveBeenCalled();
  });
  it("uses raw readers when the interval cannot use hourly rollups", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
    ] as never);
    vi.mocked(queryTrendForSitesFromHourlyRollupsPartial).mockResolvedValue(
      null,
    );
    vi.mocked(queryTrendFromD1).mockResolvedValue([]);
    await expect(readTeamTimeseries(input)).resolves.toEqual({
      data: { interval: "hour", points: [] },
      source: "raw",
      approximateVisitors: false,
    });
    expect(queryTrendFromD1).toHaveBeenCalledTimes(2);
    expect(createOverviewReader).not.toHaveBeenCalled();
  });
  it("returns an empty raw series when no sites are accessible", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([] as never);
    await expect(readTeamTimeseries(input)).resolves.toMatchObject({
      data: { points: [] },
      source: "raw",
      approximateVisitors: false,
    });
  });

  it("uses every team site when the principal has full access", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([{ id: "site-1" }] as never);
    vi.mocked(createOverviewReader).mockReturnValue({
      readOverview: vi.fn(),
      readTrend: vi.fn().mockResolvedValue({
        value: [],
        source: "raw",
        approximateVisitors: false,
      }),
    });
    await expect(
      readTeamTimeseries({ ...input, allowedSiteIds: undefined }),
    ).resolves.toMatchObject({ source: "raw" });
    expect(createOverviewReader).toHaveBeenCalledWith(input.env, "site-1");
  });
});
