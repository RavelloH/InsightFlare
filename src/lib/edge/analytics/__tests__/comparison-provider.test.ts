import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComparisonBreakdownQuery,
  ComparisonQuery,
  ComparisonTrendQuery,
  FilterDocument,
  QueryContext,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({
  createOverviewReader: vi.fn(),
  queryEventSummaryMetricsFromD1: vi.fn(),
  queryEventsTrendFromD1: vi.fn(),
  listTeamSites: vi.fn(),
  readSiteBreakdown: vi.fn(),
}));

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter",
  () => ({
    createOverviewReader: mocks.createOverviewReader,
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-summary", () => ({
  queryEventSummaryMetricsFromD1: mocks.queryEventSummaryMetricsFromD1,
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-trend", () => ({
  queryEventsTrendFromD1: mocks.queryEventsTrendFromD1,
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: mocks.listTeamSites,
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-breakdown", () => ({
  readSiteBreakdown: mocks.readSiteBreakdown,
}));

import { createComparisonProviders } from "@/lib/edge/analytics/providers/d1/comparison";

const env = {} as Env;
const filters: FilterDocument = { version: 1, root: null };
const time: QueryTime = createQueryTime(
  Date.parse("2026-08-01T00:00:00.000Z"),
  Date.parse("2026-08-03T00:00:00.000Z"),
  "UTC",
  Date.parse("2026-08-03T00:00:00.000Z"),
);
const siteContext = siteQueryContext("site-1", "api-v1");
const teamContext = teamQueryContext("team-1", "api-v1", ["site-1", "site-2"]);

function overviewMetrics(seed: number) {
  return {
    views: seed,
    sessions: seed / 2,
    visitors: seed / 3,
    bounces: seed / 10,
    totalDurationMs: seed * 100,
    durationViews: seed / 2,
  };
}

function readerFor(siteId: string) {
  const seed = siteId === "site-1" ? 100 : 200;
  return {
    readOverview: vi.fn().mockResolvedValue({
      value: overviewMetrics(seed),
      source: siteId === "site-1" ? "rollup" : "raw",
      approximateVisitors: siteId === "site-2",
    }),
    readTrend: vi.fn().mockResolvedValue({
      value: [
        {
          bucket: 0,
          timestampMs: time.range.startMs,
          ...overviewMetrics(seed),
        },
      ],
      source: "raw",
      approximateVisitors: false,
    }),
  };
}

function providerQuery(context: QueryContext, filtersForQuery = filters) {
  return {
    context,
    current: { time, filters: filtersForQuery },
    reference: { time, filters: filtersForQuery },
    metrics: ["views", "events"] as const,
  } satisfies ComparisonQuery;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createOverviewReader.mockImplementation((_, siteId: string) =>
    readerFor(siteId),
  );
  mocks.queryEventSummaryMetricsFromD1.mockResolvedValue({ events: 7 });
  mocks.queryEventsTrendFromD1.mockResolvedValue({
    data: [{ bucket: 0, timestampMs: time.range.startMs, totalEvents: 9 }],
  });
  mocks.listTeamSites.mockResolvedValue([{ id: "site-1" }, { id: "site-2" }]);
  mocks.readSiteBreakdown.mockImplementation(({ siteId }: { siteId: string }) =>
    Promise.resolve({
      items: [
        {
          key: "/shared",
          label: "/shared",
          views: siteId === "site-1" ? 10 : 20,
          sessions: 4,
          visitors: 3,
        },
        ...(siteId === "site-2"
          ? [
              {
                key: "/team-only",
                label: "/team-only",
                views: 5,
                sessions: 2,
                visitors: 1,
              },
            ]
          : []),
      ],
    }),
  );
});

describe("comparison providers", () => {
  it("adds event totals to site overview and fills calendar trend buckets", async () => {
    const providers = createComparisonProviders({ env, siteId: "site-1" });
    const overview = await providers.overview({
      side: "current",
      context: siteContext,
      query: { time, filters },
      comparison: providerQuery(siteContext),
    });
    expect(overview).toMatchObject({
      ok: true,
      data: { views: 100, events: 7 },
      meta: { source: "rollup", approximateVisitors: false },
    });

    const trend = await providers.trend({
      side: "current",
      context: siteContext,
      query: { time, filters },
      comparison: {
        ...providerQuery(siteContext),
        interval: "day",
        trendMetrics: ["views", "events"],
      } satisfies ComparisonTrendQuery,
    });
    expect(trend).toMatchObject({ ok: true, data: { interval: "day" } });
    if (trend.ok) {
      expect(trend.data.points).toHaveLength(2);
      expect(trend.data.points[0]).toMatchObject({ views: 100, events: 9 });
      expect(trend.data.points[1]).toMatchObject({ views: 0, events: 0 });
    }
  });

  it("aggregates all authorized team sites for overview and trend", async () => {
    const providers = createComparisonProviders({
      env,
      teamId: "team-1",
      allowedSiteIds: ["site-1", "site-2"],
    });
    const query = providerQuery(teamContext);
    const overview = await providers.overview({
      side: "current",
      context: teamContext,
      query: query.current,
      comparison: query,
    });
    expect(overview).toMatchObject({
      ok: true,
      data: { views: 300, events: 14 },
      meta: { source: "mixed", approximateVisitors: true },
    });

    const trend = await providers.trend({
      side: "current",
      context: teamContext,
      query: query.current,
      comparison: {
        ...query,
        interval: "day",
        trendMetrics: ["views", "events"],
      } satisfies ComparisonTrendQuery,
    });
    expect(trend.ok).toBe(true);
    if (trend.ok) expect(trend.data.points[0]).toMatchObject({ views: 300 });
  });

  it("merges complete breakdowns across sites without a per-site limit", async () => {
    const providers = createComparisonProviders({
      env,
      teamId: "team-1",
      allowedSiteIds: ["site-1", "site-2"],
    });
    const query = {
      ...providerQuery(teamContext),
      dimension: "page.path",
      limit: 20,
      sort: { by: "current.views", direction: "desc" },
    } satisfies ComparisonBreakdownQuery;
    const result = await providers.breakdown({
      side: "current",
      context: teamContext,
      query: query.current,
      comparison: query,
    });
    expect(result).toMatchObject({ ok: true, data: { complete: true } });
    expect(mocks.readSiteBreakdown).toHaveBeenCalledTimes(2);
    expect(mocks.readSiteBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", limit: 0 }),
    );
    if (result.ok) {
      expect(result.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "/shared", views: 30 }),
          expect.objectContaining({ key: "/team-only", views: 5 }),
        ]),
      );
    }
  });
});
