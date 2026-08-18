import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDemoOverview,
  generateDemoTrend,
} from "@/lib/realtime/mock/analytics-overview";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import type * as Shared from "@/lib/realtime/mock/shared";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
} from "@/lib/realtime/mock/types";

const {
  mockAggregateOverviewMetrics,
  mockApplyDemoFilters,
  mockBuildDemoFactDataset,
  mockBuildDemoTrendBuckets,
} = vi.hoisted(() => ({
  mockAggregateOverviewMetrics: vi.fn(),
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
  mockBuildDemoTrendBuckets: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/realtime/mock/fact-builder",
  );
  return {
    ...actual,
    aggregateOverviewMetrics: mockAggregateOverviewMetrics,
    applyDemoFilters: mockApplyDemoFilters,
    buildDemoFactDataset: mockBuildDemoFactDataset,
  };
});

vi.mock("@/lib/realtime/mock/shared", async () => {
  const actual = await vi.importActual<typeof Shared>(
    "@/lib/realtime/mock/shared",
  );
  return {
    ...actual,
    buildDemoTrendBuckets: mockBuildDemoTrendBuckets,
  };
});

describe("mock/analytics-overview coverage", () => {
  beforeEach(() => {
    mockAggregateOverviewMetrics.mockReset();
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
    mockBuildDemoTrendBuckets.mockReset();

    mockBuildDemoFactDataset.mockImplementation((siteId, from, to) =>
      makeDataset(Number(from), Number(to)),
    );
    mockApplyDemoFilters.mockImplementation((dataset) =>
      makeFiltered(dataset as DemoFactDataset),
    );
    mockAggregateOverviewMetrics
      .mockReturnValueOnce(makeMetrics({ views: 120, sessions: 60 }))
      .mockReturnValueOnce(makeMetrics({ views: 80, sessions: 40 }))
      .mockReturnValue(makeMetrics({ views: 30, sessions: 10 }));
    mockBuildDemoTrendBuckets.mockReturnValue([
      { bucket: 0, views: 12, sessions: 6 },
    ]);
  });

  it("includes previous-window change rates and detail buckets when requested", () => {
    const result = generateDemoOverview("site", {
      from: 1000,
      to: 2000,
      includeChange: "true",
      includeDetail: "1",
      interval: "hour",
      timeZone: "UTC",
      "filter[geo.country]": "US",
    });

    expect(mockBuildDemoFactDataset).toHaveBeenNthCalledWith(
      1,
      "site",
      1000,
      2000,
    );
    expect(mockBuildDemoFactDataset).toHaveBeenNthCalledWith(
      2,
      "site",
      0,
      1000,
    );
    expect(mockBuildDemoTrendBuckets).toHaveBeenCalledWith(
      "site",
      1000,
      2000,
      "hour",
      expect.objectContaining({ country: "us" }),
      "UTC",
    );
    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({ views: 120, sessions: 60 }),
      previousData: expect.objectContaining({ views: 80, sessions: 40 }),
      changeRates: expect.objectContaining({
        views: 0.5,
        sessions: 0.5,
        visitors: null,
      }),
      detail: {
        interval: "hour",
        data: [{ bucket: 0, views: 12, sessions: 6 }],
      },
    });
  });

  it("returns trend buckets with parsed interval, filters, and timezone", () => {
    const result = generateDemoTrend("site", {
      from: 1000,
      to: 2000,
      interval: "minute",
      tz: "UTC",
      "filter[client.browser]": "Chrome",
    });

    expect(mockBuildDemoTrendBuckets).toHaveBeenCalledWith(
      "site",
      1000,
      2000,
      "minute",
      expect.objectContaining({ browser: "Chrome" }),
      "UTC",
    );
    expect(result).toEqual({
      ok: true,
      interval: "minute",
      data: [{ bucket: 0, views: 12, sessions: 6 }],
    });
  });

  it("uses a non-zero previous window and skips optional overview sections by default", () => {
    const result = generateDemoOverview("site", {
      from: 3000,
      to: 4000,
    });

    expect(mockBuildDemoFactDataset).toHaveBeenCalledTimes(1);
    expect(mockBuildDemoFactDataset).toHaveBeenCalledWith("site", 3000, 4000);
    expect(mockBuildDemoTrendBuckets).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ views: 120, sessions: 60 }),
    });
  });

  it("computes previous windows above zero when change rates are requested", () => {
    const result = generateDemoOverview("site", {
      from: 3000,
      to: 4000,
      includeChange: "true",
    });

    expect(mockBuildDemoFactDataset).toHaveBeenNthCalledWith(
      2,
      "site",
      2000,
      3000,
    );
    expect(result).toMatchObject({
      previousData: expect.objectContaining({ views: 80 }),
      changeRates: expect.objectContaining({ views: 0.5 }),
    });
  });
});

function makeDataset(from: number, to: number): DemoFactDataset {
  return {
    from,
    to,
    viewWeight: 1,
    visits: [],
    sessions: new Map(),
    visitors: new Map(),
  };
}

function makeFiltered(dataset: DemoFactDataset): DemoFilteredFacts {
  return {
    visits: dataset.visits,
    sessions: new Set(),
    visitors: new Set(),
    visitsBySession: new Map(),
  };
}

function makeMetrics(overrides: Partial<Record<string, number>> = {}) {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    bounceRate: 0,
    approximateVisitors: false,
    ...overrides,
  };
}
