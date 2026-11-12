import { describe, expect, it, vi } from "vitest";

import type * as TimeZone from "@/lib/analytics/time-zone";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import { fillMissingTrafficData } from "@/lib/dashboard/traffic-chart-data";

type TimeZoneModule = typeof TimeZone;

vi.mock("@/lib/analytics/time-zone", async (importOriginal) => {
  const actual = await importOriginal<TimeZoneModule>();
  return {
    ...actual,
    // A zoned adder that never advances forces the chart onto its fixed-step
    // fallback so it can never loop on the same bucket.
    addZonedInterval: (value: number) => value,
    startOfZonedInterval: (value: number) => value,
  };
});

const STEP_MS: Record<DashboardInterval, number> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
};

describe("traffic chart fixed-step fallback", () => {
  it.each(Object.entries(STEP_MS) as [DashboardInterval, number][])(
    "advances a %s chart by its approximate duration when the zoned step stalls",
    (interval, step) => {
      const first = Date.UTC(2026, 7, 1);
      const filled = fillMissingTrafficData(
        [
          { timestampMs: first, views: 4, visitors: 2 },
          { timestampMs: first + 2 * step, views: 6, visitors: 3 },
        ],
        interval,
        "UTC",
      );

      expect(filled.map((point) => point.timestampMs)).toEqual([
        first,
        first + step,
        first + 2 * step,
      ]);
      expect(filled.map((point) => point.views)).toEqual([4, 0, 6]);
    },
  );
});
