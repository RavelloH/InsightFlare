import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard/time-zone", () => ({
  addZonedInterval: vi.fn(() => Number.NaN),
  startOfZonedInterval: vi.fn((timestampMs: number) => timestampMs),
}));

import { buildTeamAggregateTrend } from "@/lib/dashboard/team-dashboard-query";

describe("team dashboard timeline fallback", () => {
  it.each(["minute", "hour", "day", "week", "month"] as const)(
    "uses a fixed %s step when the zoned increment is unusable",
    (interval) => {
      expect(
        buildTeamAggregateTrend([], {
          from: 0,
          to: 1,
          interval,
          timeZone: "UTC",
        }),
      ).toEqual([{ timestampMs: 0, sites: [] }]);
    },
  );
});
