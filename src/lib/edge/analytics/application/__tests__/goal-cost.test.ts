import { describe, expect, it } from "vitest";

import {
  GOAL_TIMESERIES_MAX_BUCKETS,
  goalQueryCost,
} from "@/lib/edge/analytics/application/goal-cost";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

describe("goalQueryCost", () => {
  it("keeps the Goal timeseries bucket ceiling at 512", () => {
    expect(GOAL_TIMESERIES_MAX_BUCKETS).toBe(512);

    const atLimit = goalQueryCost({
      filters: EMPTY_FILTER_DOCUMENT,
      startMs: 0,
      endExclusiveMs: GOAL_TIMESERIES_MAX_BUCKETS * 60_000,
      timeZone: "UTC",
      interval: "minute",
    });
    const overLimit = goalQueryCost({
      filters: EMPTY_FILTER_DOCUMENT,
      startMs: 0,
      endExclusiveMs: (GOAL_TIMESERIES_MAX_BUCKETS + 1) * 60_000,
      timeZone: "UTC",
      interval: "minute",
    });

    expect(atLimit.bucketCount).toBe(GOAL_TIMESERIES_MAX_BUCKETS);
    expect(overLimit.bucketCount).toBe(GOAL_TIMESERIES_MAX_BUCKETS + 1);
  });

  it("keeps global and persisted Goal matcher complexity separate", () => {
    const cost = goalQueryCost({
      filters: parseFilterDsl(
        'page.path eq "/checkout"',
        analyticsFilterRegistry,
      ),
      startMs: 0,
      endExclusiveMs: 86_400_000,
      timeZone: "UTC",
      goalFilterComplexity: 12,
    });

    expect(cost).toMatchObject({
      rangeMs: 86_400_000,
      metricCount: 2,
      filterComplexity: 1,
      goalFilterComplexity: 12,
      requiresRawSource: true,
      provider: "d1",
    });
  });

  it("counts calendar buckets and fails closed beyond the shared limit", () => {
    const cost = goalQueryCost({
      filters: EMPTY_FILTER_DOCUMENT,
      startMs: 0,
      endExclusiveMs: 2_001 * 60_000,
      timeZone: "UTC",
      interval: "minute",
    });

    expect(cost.bucketCount).toBe(GOAL_TIMESERIES_MAX_BUCKETS + 1);
  });

  it("fails closed when the calendar bucket plan cannot be built", () => {
    const cost = goalQueryCost({
      filters: EMPTY_FILTER_DOCUMENT,
      startMs: Number.NaN,
      endExclusiveMs: 60_000,
      timeZone: "Not/A_TimeZone",
      interval: "day",
    });

    expect(cost.bucketCount).toBe(GOAL_TIMESERIES_MAX_BUCKETS + 1);
  });
});
