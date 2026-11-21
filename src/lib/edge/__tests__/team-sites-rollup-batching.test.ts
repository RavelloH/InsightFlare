import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachFilterScopePreference } from "@/lib/edge/analytics/contract";
import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  queryTeamLatestActivityFromD1,
  queryTeamOverviewFromD1,
  queryTeamSitesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  createOverviewReader,
  readLatestSiteActivity,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  queryTeamSitesPageFromD1: vi.fn(),
  queryTeamOverviewFromD1: vi.fn(),
  queryTeamLatestActivityFromD1: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries",
  () => ({
    queryOverviewAndTrendForSitesFromHourlyRollupsPartial: vi.fn(),
    queryOverviewForSitesFromHourlyRollupsPartial: vi.fn(),
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/overview", () => ({
  queryTrendFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/overview-reader", () => ({
  createOverviewReader: vi.fn(),
  readLatestSiteActivity: vi.fn(),
  toQueryTime: vi.fn((window) => ({
    range: { startMs: window.startMs, endExclusiveMs: window.endExclusiveMs },
    capturedAtMs: window.nowMs,
    reportingTimeZone: window.timeZone,
  })),
}));

const filter = { version: 1 as const, root: null };
const window = {
  startMs: 0,
  endExclusiveMs: 24 * 3600000,
  nowMs: 24 * 3600000,
  timeZone: "UTC",
};
const env = {} as Env;
const aggregate = (views: number) => ({
  views,
  sessions: 2,
  visitors: 2,
  bounces: 1,
  totalDuration: 20,
  durationViews: 4,
});
const row = (siteId: string, views: number) => ({
  siteId,
  bucket: 0,
  timestampMs: 0,
  ...aggregate(views),
});
const input = {
  env,
  teamId: "team-1",
  window,
  interval: "hour" as const,
  filters: filter,
};
const site = (id: string) => ({
  id,
  teamId: "team-1",
  name: id,
  domain: `${id}.test`,
  publicEnabled: 1,
  publicSlug: id,
  createdAt: 1,
  updatedAt: 2,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createOverviewReader).mockReturnValue({
    readOverview: vi.fn(async () => ({
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
    })),
    readTrend: vi.fn(async () => ({
      value: [],
      source: "raw",
      approximateVisitors: false,
    })),
  } as never);
  vi.mocked(readLatestSiteActivity).mockResolvedValue(null);
});
describe("team-sites multi-site hourly rollup and safe fallback", () => {
  it("reads 16 sites with a single grouped rollup and activity batch rather than 48 per-site queries", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `site-${i + 1}`);
    vi.mocked(queryTeamSitesPageFromD1).mockResolvedValue({
      rows: ids.map(site),
      nextCursor: null,
    });
    vi.mocked(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).mockResolvedValue({
      overview: new Map(ids.map((id) => [id, aggregate(5)])),
      trend: new Map(ids.map((id) => [id, [row(id, 5)]])),
    } as never);
    vi.mocked(queryTeamLatestActivityFromD1).mockResolvedValue(
      new Map(ids.map((id) => [id, 1000])),
    );
    const result = await readTeamSites(input);
    expect(result.data.items).toHaveLength(16);
    expect(result.data.items[0]).toMatchObject({
      siteId: "site-1",
      lastEventAtMs: 1000,
      metrics: { views: 5 },
      trend: [{ views: 5 }],
    });
    expect(result.source).toBe("rollup");
    expect(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).toHaveBeenCalledTimes(1);
    expect(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).toHaveBeenCalledWith(env, ids, window, "hour");
    expect(queryTeamLatestActivityFromD1).toHaveBeenCalledTimes(1);
    expect(createOverviewReader).not.toHaveBeenCalled();
    expect(readLatestSiteActivity).not.toHaveBeenCalled();
    expect(queryTeamOverviewFromD1).not.toHaveBeenCalled();
    expect(queryTrendFromD1).not.toHaveBeenCalled();
  });

  it("falls back only for missing rollup sites and preserves all six trend metrics", async () => {
    vi.mocked(queryTeamSitesPageFromD1).mockResolvedValue({
      rows: [site("a"), site("b")],
      nextCursor: null,
    });
    vi.mocked(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).mockResolvedValue({
      overview: new Map([["a", aggregate(8)]]),
      trend: new Map([["a", [row("a", 8)]]]),
    } as never);
    vi.mocked(queryTeamLatestActivityFromD1).mockResolvedValue(
      new Map([["a", 33]]),
    );
    vi.mocked(queryTeamOverviewFromD1).mockResolvedValue(
      new Map([["b", aggregate(7)]]),
    );
    vi.mocked(queryTrendFromD1).mockResolvedValue([row("b", 7)] as never);
    const result = await readTeamSites(input);
    expect(result.source).toBe("mixed");
    expect(result.data.items[0]).toMatchObject({
      siteId: "a",
      metrics: { views: 8 },
      trend: [{ views: 8 }],
    });
    expect(result.data.items[1]).toMatchObject({
      siteId: "b",
      lastEventAtMs: null,
      metrics: {
        views: 7,
        sessions: 2,
        visitors: 2,
        bounces: 1,
        totalDurationMs: 20,
        durationViews: 4,
      },
      trend: [
        {
          views: 7,
          sessions: 2,
          visitors: 2,
          bounces: 1,
          totalDurationMs: 20,
          durationViews: 4,
        },
      ],
    });
    expect(queryTeamOverviewFromD1).toHaveBeenCalledWith(
      env,
      ["b"],
      window,
      undefined,
      filter,
    );
    expect(queryTrendFromD1).toHaveBeenCalledTimes(1);
    expect(createOverviewReader).not.toHaveBeenCalled();
  });

  it("falls back only Trend when calendar boundaries disallow hourly trend buckets", async () => {
    vi.mocked(queryTeamSitesPageFromD1).mockResolvedValue({
      rows: [site("a")],
      nextCursor: null,
    });
    vi.mocked(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).mockResolvedValue({
      overview: new Map([["a", aggregate(5)]]),
      trend: null,
    });
    vi.mocked(queryTeamLatestActivityFromD1).mockResolvedValue(new Map());
    vi.mocked(queryTrendFromD1).mockResolvedValue([row("a", 5)] as never);
    const result = await readTeamSites(input);
    expect(result.data.items[0]).toMatchObject({
      metrics: { views: 5 },
      trend: [{ views: 5 }],
    });
    expect(result.source).toBe("mixed");
    expect(queryTeamOverviewFromD1).not.toHaveBeenCalled();
    expect(queryTrendFromD1).toHaveBeenCalledTimes(1);
  });

  it("keeps empty Session/Visitor scope on entity-aware readers without Event rollups", async () => {
    vi.mocked(queryTeamSitesPageFromD1).mockResolvedValue({
      rows: [site("a")],
      nextCursor: null,
    });
    const session = attachFilterScopePreference(filter, "session");
    const result = await readTeamSites({ ...input, filters: session });
    expect(result.data.items).toHaveLength(1);
    expect(createOverviewReader).toHaveBeenCalledWith(env, "a");
    expect(readLatestSiteActivity).toHaveBeenCalledTimes(1);
    expect(queryTeamLatestActivityFromD1).not.toHaveBeenCalled();
    expect(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).not.toHaveBeenCalled();
  });

  it("does not fetch trend rollups when optional interval was omitted", async () => {
    vi.mocked(queryTeamSitesPageFromD1).mockResolvedValue({
      rows: [site("a")],
      nextCursor: null,
    });
    vi.mocked(queryOverviewForSitesFromHourlyRollupsPartial).mockResolvedValue(
      new Map([["a", aggregate(3)]]),
    );
    vi.mocked(queryTeamLatestActivityFromD1).mockResolvedValue(new Map());
    const result = await readTeamSites({ ...input, interval: undefined });
    expect(result.data.items[0].trend).toBeUndefined();
    expect(queryOverviewForSitesFromHourlyRollupsPartial).toHaveBeenCalledTimes(
      1,
    );
    expect(
      queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
    ).not.toHaveBeenCalled();
    expect(createOverviewReader).not.toHaveBeenCalled();
  });
});
