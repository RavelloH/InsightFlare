import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/overview", () => ({
  queryLatestSiteActivity: vi.fn(),
  queryOverviewAggregate: vi.fn(),
  queryTrendAggregate: vi.fn(),
}));

import {
  queryLatestSiteActivity,
  queryOverviewAggregate,
  queryTrendAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  createOverviewReader,
  readLatestSiteActivity,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";

const env = {} as never;
const window = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 200,
  timeZone: "UTC",
};
const filters = { version: 1 as const, root: null };

describe("D1 overview reader", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps canonical overview and timeseries values without query context", async () => {
    vi.mocked(queryOverviewAggregate).mockResolvedValue({
      value: {
        views: 4,
        sessions: 2,
        visitors: 3,
        bounces: 1,
        totalDuration: 80,
        durationViews: 2,
      },
      diagnosticSource: "rollup",
      approximateVisitors: true,
    } as never);
    vi.mocked(queryTrendAggregate).mockResolvedValue({
      value: [
        {
          bucket: 0,
          timestampMs: 100,
          views: 4,
          sessions: 2,
          visitors: 3,
          bounces: 1,
          totalDuration: 80,
          durationViews: 2,
        },
      ],
    } as never);

    const reader = createOverviewReader(env, "site-1");
    await expect(
      reader.readOverview({ time: toQueryTime(window), filters }),
    ).resolves.toMatchObject({
      value: { views: 4, totalDurationMs: 80 },
      source: "rollup",
      approximateVisitors: true,
    });
    await expect(
      reader.readTrend({ time: toQueryTime(window), filters, interval: "day" }),
    ).resolves.toMatchObject({
      value: [{ bucket: 0, totalDurationMs: 80 }],
      source: "raw",
    });
    expect(queryOverviewAggregate).toHaveBeenCalledWith(
      env,
      "site-1",
      window,
      filters,
      expect.anything(),
    );
  });

  it("delegates latest activity through the same pure provider boundary", async () => {
    vi.mocked(queryLatestSiteActivity).mockResolvedValue(175);
    await expect(
      readLatestSiteActivity(env, "site-1", window, filters),
    ).resolves.toBe(175);
    expect(queryLatestSiteActivity).toHaveBeenCalledWith(
      env,
      "site-1",
      window,
      filters,
      expect.anything(),
    );
  });
});
