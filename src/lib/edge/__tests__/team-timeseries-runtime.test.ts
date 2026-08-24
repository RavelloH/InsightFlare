import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter",
  () => ({
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
  }),
);

import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
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
    await expect(readTeamTimeseries(input)).resolves.toMatchObject({
      data: { interval: "hour", points: [{ views: 10, sessions: 2 }] },
      source: "mixed",
      approximateVisitors: true,
    });
    expect(createOverviewReader).toHaveBeenCalledTimes(2);
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
