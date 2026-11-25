import { describe, expect, it } from "vitest";

import {
  downsampleTrafficData,
  fillMissingTrafficData,
  safeChartCount,
} from "@/lib/dashboard/traffic-chart-data";

import {
  addZonedInterval as productAdd,
  startOfZonedInterval as productStart,
} from "../../../../packages/product-ui/src/charts/time-zone";
import { fillMissingTrafficData as productFill } from "../../../../packages/product-ui/src/charts/traffic-chart-data";

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

  it("preserves calendar buckets and counts across repeated chart calls, UTC and DST", () => {
    const from = Date.UTC(2026, 2, 6, 12);
    const range = { from, to: Date.UTC(2026, 2, 11, 12) };
    const rows = [
      { timestampMs: from, views: 10, visitors: 5 },
      { timestampMs: range.to, views: 3, visitors: 2 },
    ];
    for (const zone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      for (const interval of ["hour", "day", "week", "month"] as const) {
        const expected = fillMissingTrafficData(rows, interval, zone, range);
        expect(productFill(rows, interval, zone, range)).toEqual(expected);
        expect(productFill(rows, interval, zone, range)).toEqual(expected);
      }
    }
    for (const ts of [
      0,
      from,
      Date.UTC(2026, 10, 1, 9),
      Date.UTC(2024, 1, 29, 23, 59, 59, 999),
    ]) {
      for (const interval of [
        "minute",
        "hour",
        "day",
        "week",
        "month",
      ] as const) {
        expect(productStart(ts, interval, "UTC")).toBe(
          productStart(ts, interval, "Etc/UTC"),
        );
        expect(productAdd(ts, interval, "UTC")).toBe(
          productAdd(ts, interval, "Etc/UTC"),
        );
      }
    }
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
