import { describe, expect, it } from "vitest";

import { comparisonCacheKey } from "@/lib/edge/analytics/application/comparison-cache";
import {
  type ComparisonBreakdownQuery,
  type ComparisonRawBreakdownResult,
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { executeComparisonBreakdown } from "@/lib/edge/analytics/contract/comparison";
import {
  comparisonMetricDelta,
  projectComparisonMetrics,
  relativeComparisonDelta,
} from "@/lib/edge/analytics/contract/comparison-metrics";

const context = siteQueryContext("site-1", "api-v1");
const time = createQueryTime(
  Date.parse("2026-08-01T00:00:00.000Z"),
  Date.parse("2026-08-02T00:00:00.000Z"),
  "UTC",
  Date.parse("2026-08-02T00:00:00.000Z"),
);

function raw(views: number, sessions = 0) {
  return {
    views,
    sessions,
    visitors: views,
    bounces: 0,
    totalDurationMs: sessions * 100,
    durationViews: sessions,
    events: views * 2,
  };
}

describe("typed comparison contract", () => {
  it("projects raw and derived metrics without averaging ratios", () => {
    const projected = projectComparisonMetrics({ ...raw(10, 4), bounces: 1 }, [
      "views",
      "avgDurationMs",
      "bounceRate",
      "viewsPerSession",
      "events",
    ]);
    expect(projected).toEqual({
      views: 10,
      avgDurationMs: 100,
      bounceRate: 0.25,
      viewsPerSession: 2.5,
      events: 20,
    });
  });

  it("uses null for undefined ratios and zero for 0/0 relative change", () => {
    expect(
      projectComparisonMetrics(raw(1, 0), ["avgDurationMs", "bounceRate"]),
    ).toEqual({ avgDurationMs: null, bounceRate: null });
    expect(relativeComparisonDelta(0, 0)).toBe(0);
    expect(relativeComparisonDelta(1, 0)).toBeNull();
    expect(comparisonMetricDelta(null, 2)).toEqual({
      absolute: null,
      relative: null,
    });
  });

  it("sorts a complete breakdown union before applying the limit", async () => {
    const query: ComparisonBreakdownQuery = {
      context,
      current: { time, filters: { version: 1, root: null } },
      reference: { time, filters: { version: 1, root: null } },
      metrics: ["views", "sessions", "visitors"],
      dimension: "page.path",
      limit: 2,
      sort: { by: "change.views.absolute", direction: "desc" },
    };
    const provider = async ({
      side,
    }: {
      readonly side: "current" | "reference";
    }) => {
      const items: ComparisonRawBreakdownResult =
        side === "current"
          ? {
              complete: true,
              items: [
                { key: "/a", label: "/a", ...raw(100) },
                { key: "/b", label: "/b", ...raw(20) },
              ],
            }
          : {
              complete: true,
              items: [
                { key: "/a", label: "/a", ...raw(10) },
                { key: "/c", label: "/c", ...raw(1) },
              ],
            };
      return {
        ok: true as const,
        data: items,
        meta: { time, source: "raw" as const, approximateVisitors: false },
      };
    };
    const result = await executeComparisonBreakdown(query, provider);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.items.map((item) => item.key)).toEqual(["/a", "/b"]);
  });

  it("canonicalizes cache identity independently of JSON key order", async () => {
    const input = {
      operation: "site.analytics.comparison",
      subjectFingerprint: "site-1",
      policyRevision: "policy-1",
    };
    const first = await comparisonCacheKey({
      ...input,
      query: {
        current: { from: 1, to: 2 },
        reference: { from: 0, to: 1 },
        select: { metrics: ["views"] },
      },
    });
    const second = await comparisonCacheKey({
      ...input,
      query: {
        select: { metrics: ["views"] },
        reference: { to: 1, from: 0 },
        current: { to: 2, from: 1 },
      },
    });
    expect(first).toBe(second);
  });
});
