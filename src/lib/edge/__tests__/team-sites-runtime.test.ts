import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter",
  () => ({
    createOverviewReader: vi.fn(),
    readLatestSiteActivity: vi.fn(),
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

import {
  createOverviewReader,
  readLatestSiteActivity,
} from "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";

const input = {
  env: {} as never,
  teamId: "team-1",
  allowedSiteIds: ["site-1"],
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  interval: "hour" as const,
  filters: { version: 1 as const, root: null },
};

describe("team sites runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only authorized metadata with typed metrics, trends, and activity", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      {
        id: "site-1",
        name: "One",
        domain: "one.test",
        publicEnabled: 1,
        publicSlug: "one",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "site-2",
        name: "Two",
        domain: "two.test",
        publicEnabled: 0,
        publicSlug: null,
        createdAt: 3,
        updatedAt: 4,
      },
    ] as never);
    vi.mocked(createOverviewReader).mockReturnValue({
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 4,
          sessions: 2,
          visitors: 2,
          bounces: 1,
          totalDurationMs: 20,
          durationViews: 4,
        },
        source: "rollup",
        approximateVisitors: false,
      }),
      readTrend: vi.fn().mockResolvedValue({
        value: [
          {
            bucket: 0,
            timestampMs: 0,
            views: 4,
            sessions: 2,
            visitors: 2,
            bounces: 1,
            totalDurationMs: 20,
            durationViews: 4,
          },
        ],
        source: "rollup",
        approximateVisitors: false,
      }),
    });
    vi.mocked(readLatestSiteActivity).mockResolvedValue(0);

    await expect(readTeamSites(input)).resolves.toMatchObject({
      data: {
        sites: [{ siteId: "site-1", publicEnabled: true, lastEventAtMs: 0 }],
      },
      source: "rollup",
      approximateVisitors: false,
    });
    expect(createOverviewReader).toHaveBeenCalledWith(input.env, "site-1");
    expect(readLatestSiteActivity).toHaveBeenCalledWith(
      input.env,
      "site-1",
      input.window,
      input.filters,
    );
  });

  it("allows all sites when unrestricted and preserves mixed/approximate provenance", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([{ id: "site-1" }] as never);
    vi.mocked(createOverviewReader).mockReturnValue({
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 0,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
        source: "raw",
        approximateVisitors: false,
      }),
      readTrend: vi.fn().mockResolvedValue({
        value: [],
        source: "rollup",
        approximateVisitors: true,
      }),
    });
    vi.mocked(readLatestSiteActivity).mockResolvedValue(null);
    await expect(
      readTeamSites({ ...input, allowedSiteIds: undefined }),
    ).resolves.toMatchObject({ source: "mixed", approximateVisitors: true });
  });

  it("returns no sites without readers and rejects unauthorized filters", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([] as never);
    await expect(readTeamSites(input)).resolves.toMatchObject({
      data: { sites: [] },
      source: "raw",
    });
    expect(createOverviewReader).not.toHaveBeenCalled();
    await expect(
      readTeamSites({
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
    ).rejects.toThrow("invalid-input");
  });

  it("does not request trends when the composite omitted its optional interval", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([{ id: "site-1" }] as never);
    const readTrend = vi.fn();
    vi.mocked(createOverviewReader).mockReturnValue({
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 1,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 1,
          durationViews: 1,
        },
        source: "raw",
        approximateVisitors: false,
      }),
      readTrend,
    });
    vi.mocked(readLatestSiteActivity).mockResolvedValue(null);
    const result = await readTeamSites({ ...input, interval: undefined });
    expect(result).toMatchObject({
      data: { sites: [{ siteId: "site-1" }] },
      source: "raw",
    });
    expect(result.data.sites[0]).not.toHaveProperty("trend");
    expect(readTrend).not.toHaveBeenCalled();
  });
});
