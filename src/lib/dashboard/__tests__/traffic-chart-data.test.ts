import { describe, expect, it } from "vitest";

import {
  downsampleTrafficData,
  fillMissingTrafficData,
  safeChartCount,
} from "@/lib/dashboard/traffic-chart-data";

describe("traffic chart data", () => {
  it("normalizes invalid counts", () => {
    expect(safeChartCount(Number.NaN)).toBe(0);
    expect(safeChartCount(-2)).toBe(0);
    expect(safeChartCount(2.6)).toBe(3);
  });

  it("fills missing reporting intervals", () => {
    const data = fillMissingTrafficData(
      [
        { timestampMs: Date.UTC(2026, 7, 1), views: 10, visitors: 5 },
        { timestampMs: Date.UTC(2026, 7, 3), views: 6, visitors: 3 },
      ],
      "day",
      "UTC",
    );

    expect(data).toEqual([
      { timestampMs: Date.UTC(2026, 7, 1), views: 10, visitors: 5 },
      { timestampMs: Date.UTC(2026, 7, 2), views: 0, visitors: 0 },
      { timestampMs: Date.UTC(2026, 7, 3), views: 6, visitors: 3 },
    ]);
  });

  it("starts an all-time chart at its first valid data point", () => {
    const first = Date.UTC(2026, 7, 1);
    expect(
      fillMissingTrafficData(
        [
          { timestampMs: first, views: 10, visitors: 5 },
          { timestampMs: first + 2 * 86_400_000, views: 6, visitors: 3 },
        ],
        "day",
        "UTC",
        { from: 0, to: Date.UTC(2026, 7, 4) },
      ),
    ).toEqual([
      { timestampMs: first, views: 10, visitors: 5 },
      { timestampMs: first + 86_400_000, views: 0, visitors: 0 },
      { timestampMs: first + 2 * 86_400_000, views: 6, visitors: 3 },
      { timestampMs: first + 3 * 86_400_000, views: 0, visitors: 0 },
    ]);
  });

  it("downsamples counts without exceeding the view total", () => {
    expect(
      downsampleTrafficData(
        [
          { timestampMs: 1, views: 2, visitors: 3 },
          { timestampMs: 2, views: 4, visitors: 2 },
          { timestampMs: 3, views: 5, visitors: 4 },
        ],
        2,
      ),
    ).toEqual([
      { timestampMs: 2, views: 6, visitors: 5 },
      { timestampMs: 3, views: 5, visitors: 4 },
    ]);
  });
});
