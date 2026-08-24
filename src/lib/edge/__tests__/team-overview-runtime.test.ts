import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
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
      readTeamOverview({ ...input, allowedSiteIds: undefined }),
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
