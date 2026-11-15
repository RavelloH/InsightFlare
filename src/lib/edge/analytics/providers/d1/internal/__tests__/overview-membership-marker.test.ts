// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import type { EventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import * as rollups from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import {
  queryOverviewAggregate,
  queryOverviewFromD1,
  queryTrendAggregate,
  queryTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import type { Env } from "@/lib/edge/types";

afterEach(() => vi.restoreAllMocks());

const window = {
  startMs: 1700000000000,
  endExclusiveMs: 1700086400000,
  nowMs: 1700086400000,
  timeZone: "UTC",
};
const filters = { version: 1 as const, root: null };
const aggregate = {
  views: 7,
  sessions: 3,
  visitors: 2,
  bounces: 1,
  totalDuration: 11,
  durationViews: 6,
};
const trend = { ...aggregate, bucket: 0, timestampMs: window.startMs };

for (const extension of ["ordinary", "inherited", "accessor"] as const) {
  function legacy(bindPlan: EventMembershipFallback["bindPlan"]) {
    const getKind = vi.fn(() => "whole-original-overview");
    const membership: EventMembershipFallback = { bindPlan };
    if (extension === "ordinary") {
      Object.defineProperty(membership, "kind", { value: "diagnostic" });
    } else if (extension === "inherited") {
      Object.setPrototypeOf(membership, { kind: "whole-original-overview" });
    } else {
      Object.defineProperty(membership, "kind", { get: getKind });
    }
    return { membership, getKind };
  }

  it(`preserves the legacy raw binder for an ${extension} kind extension`, async () => {
    const sentinel = new Error("legacy binder sentinel");
    const bindPlan = vi.fn(() => {
      throw sentinel;
    });
    const { membership, getKind } = legacy(bindPlan);
    await expect(
      queryOverviewFromD1(
        {} as Env,
        "site",
        window,
        filters,
        undefined,
        membership,
      ),
    ).rejects.toBe(sentinel);
    await expect(
      queryTrendFromD1(
        {} as Env,
        "site",
        window,
        "day",
        filters,
        undefined,
        membership,
      ),
    ).rejects.toBe(sentinel);
    expect(bindPlan).toHaveBeenCalledTimes(2);
    expect(getKind).not.toHaveBeenCalled();
  });

  it(`preserves legacy rollups for an ${extension} kind extension`, async () => {
    const bindPlan = vi.fn(() => {
      throw new Error("rollup must not call a raw binder");
    });
    const { membership, getKind } = legacy(bindPlan);
    const overviewRollup = vi
      .spyOn(rollups, "queryOverviewForSitesFromHourlyRollups")
      .mockResolvedValue(new Map([["site", aggregate]]));
    const trendRollup = vi
      .spyOn(rollups, "queryTrendForSitesFromHourlyRollups")
      .mockResolvedValue([{ ...trend, siteId: "site" }]);
    await expect(
      queryOverviewAggregate(
        {} as Env,
        "site",
        window,
        filters,
        undefined,
        membership,
      ),
    ).resolves.toEqual({
      value: aggregate,
      source: "d1",
      diagnosticSource: "rollup",
      approximateVisitors: false,
    });
    await expect(
      queryTrendAggregate(
        {} as Env,
        "site",
        window,
        "day",
        filters,
        undefined,
        membership,
      ),
    ).resolves.toEqual({
      value: [trend],
      source: "d1",
      diagnosticSource: "rollup",
    });
    expect(overviewRollup).toHaveBeenCalledTimes(1);
    expect(trendRollup).toHaveBeenCalledTimes(1);
    expect(bindPlan).not.toHaveBeenCalled();
    expect(getKind).not.toHaveBeenCalled();
  });
}
