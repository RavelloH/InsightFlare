import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/performance", () => ({
  queryAllPerformanceTrendsFromD1: vi.fn(),
  queryPerformanceCountriesFromD1: vi.fn(),
  queryPerformanceRoutesFromD1: vi.fn(),
  queryPerformanceSummariesFromD1: vi.fn(),
}));

import type { FilterFieldId } from "@/lib/edge/analytics/contract";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import {
  readSitePerformanceBreakdown,
  type ReadSitePerformanceInput,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";

const metric = {
  avg: 1,
  p50: 1,
  p75: 1,
  p95: 1,
  samples: 1,
};
const metrics = {
  ttfb: metric,
  fcp: metric,
  lcp: metric,
  cls: metric,
  inp: metric,
};
const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  filters: {
    version: 1 as const,
    root: {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "page.path" as FilterFieldId },
      operator: "eq" as const,
      value: "/pricing",
    },
  },
} satisfies ReadSitePerformanceInput;

describe("site performance runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("executes typed performance summary and timeseries providers", async () => {
    vi.mocked(queryPerformanceSummariesFromD1).mockResolvedValue(metrics);
    await expect(readSitePerformanceSummary(input)).resolves.toEqual({
      metrics,
    });
    expect(queryPerformanceSummariesFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
    );

    vi.mocked(queryAllPerformanceTrendsFromD1).mockResolvedValue({
      ttfb: [{ bucket: 0, timestampMs: 0, ...metric }],
      fcp: [],
      lcp: [],
      cls: [],
      inp: [],
    });
    await expect(
      readSitePerformanceTimeseries({ ...input, interval: "day" }),
    ).resolves.toMatchObject({
      interval: "day",
      series: { ttfb: [{ timestamp: "1970-01-01T00:00:00.000Z" }] },
    });
  });

  it("passes canonical filters through without audience policy", async () => {
    await expect(
      readSitePerformanceSummary({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "unknown.field" as FilterFieldId },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(queryPerformanceSummariesFromD1).toHaveBeenCalled();
  });

  it("limits performance breakdowns to supported typed dimensions", async () => {
    vi.mocked(queryPerformanceRoutesFromD1).mockResolvedValue([
      { pathname: "/pricing", views: 10, metrics },
    ]);
    await expect(
      readSitePerformanceBreakdown({
        ...input,
        dimension: "page.path",
        metric: "lcp",
        limit: 20,
      }),
    ).resolves.toMatchObject({
      dimension: "page.path",
      metric: "lcp",
      items: [{ key: "/pricing", p75: 1 }],
    });
    await expect(
      readSitePerformanceBreakdown({
        ...input,
        dimension: "client.browser",
        metric: "lcp",
        limit: 20,
      }),
    ).rejects.toThrow("unsupported-dimension");
    vi.mocked(queryPerformanceCountriesFromD1).mockResolvedValue([
      { country: "US", views: 8, metrics },
    ]);
    await expect(
      readSitePerformanceBreakdown({
        ...input,
        dimension: "geo.country",
        metric: "lcp",
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [{ key: "US", label: "US" }] });
  });

  it("preserves provider failures for the application boundary", async () => {
    vi.mocked(queryPerformanceSummariesFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(readSitePerformanceSummary(input)).rejects.toThrow("down");
    vi.mocked(queryAllPerformanceTrendsFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSitePerformanceTimeseries({ ...input, interval: "day" }),
    ).rejects.toThrow("down");
  });
});
