import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-goal-summary",
  () => ({
    readSiteGoalSummary: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries",
  () => ({
    readSiteGoalTimeseries: vi.fn(),
  }),
);

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { registerGoalProviders } from "@/lib/edge/analytics/composition/d1/goals";
import { readSiteGoalSummary } from "@/lib/edge/analytics/providers/d1/operations/site-goal-summary";
import { readSiteGoalTimeseries } from "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries";

const input = {
  goalId: "goal-1",
  interval: "hour",
  time: {
    range: { startMs: 1_000, endExclusiveMs: 3_000 },
    capturedAtMs: 3_000,
    reportingTimeZone: "UTC",
  },
  filters: { version: 1 as const, root: null },
  scopedDataset: { scope: "event" },
};

describe("D1 Goal provider composition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers summary and timeseries providers with the canonical request shape", async () => {
    const summary = { goal: { id: "goal-1" }, summary: {} };
    const timeseries = {
      goal: { id: "goal-1" },
      interval: "hour",
      timeseries: [],
    };
    vi.mocked(readSiteGoalSummary).mockResolvedValue(summary as never);
    vi.mocked(readSiteGoalTimeseries).mockResolvedValue(timeseries as never);

    const registry = new AnalyticsProviderRegistry();
    const env = {} as never;
    registerGoalProviders(registry, { env, siteId: "site-1" } as never);

    await expect(
      registry.resolve("goal-summary")?.execute(input as never),
    ).resolves.toEqual({ value: summary });
    await expect(
      registry.resolve("goal-timeseries")?.execute(input as never),
    ).resolves.toEqual({ value: timeseries });

    expect(readSiteGoalSummary).toHaveBeenCalledWith({
      env,
      siteId: "site-1",
      goalId: "goal-1",
      window: {
        startMs: 1_000,
        endExclusiveMs: 3_000,
        nowMs: 3_000,
        timeZone: "UTC",
      },
      filters: input.filters,
      scopedDataset: input.scopedDataset,
    });
    expect(readSiteGoalTimeseries).toHaveBeenCalledWith({
      env,
      siteId: "site-1",
      goalId: "goal-1",
      interval: "hour",
      window: {
        startMs: 1_000,
        endExclusiveMs: 3_000,
        nowMs: 3_000,
        timeZone: "UTC",
      },
      filters: input.filters,
      scopedDataset: input.scopedDataset,
    });
  });

  it("rejects missing provider input instead of creating an unscoped query", async () => {
    const registry = new AnalyticsProviderRegistry();
    registerGoalProviders(registry, {
      env: {} as never,
      siteId: "site-1",
    } as never);

    await expect(
      registry.resolve("goal-summary")?.execute(undefined as never),
    ).rejects.toThrow("goal_query_missing");
    await expect(
      registry.resolve("goal-timeseries")?.execute(undefined as never),
    ).rejects.toThrow("goal_query_missing");
  });

  it("uses safe defaults when optional provider fields are absent", async () => {
    const summary = { goal: null, summary: null };
    const timeseries = { goal: null, interval: "day", timeseries: [] };
    vi.mocked(readSiteGoalSummary).mockResolvedValue(summary as never);
    vi.mocked(readSiteGoalTimeseries).mockResolvedValue(timeseries as never);
    const registry = new AnalyticsProviderRegistry();
    registerGoalProviders(registry, {
      env: {} as never,
      siteId: "site-1",
    } as never);

    const minimal = {
      time: input.time,
    };
    await expect(
      registry.resolve("goal-summary")?.execute(minimal as never),
    ).resolves.toEqual({ value: summary });
    await expect(
      registry.resolve("goal-timeseries")?.execute(minimal as never),
    ).resolves.toEqual({ value: timeseries });
    expect(readSiteGoalSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: "",
        filters: { version: 1, root: null },
      }),
    );
    expect(readSiteGoalTimeseries).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: "",
        interval: "day",
        filters: { version: 1, root: null },
      }),
    );
  });
});
