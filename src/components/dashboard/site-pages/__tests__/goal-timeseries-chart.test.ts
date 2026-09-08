import { describe, expect, it } from "vitest";

import { normalizeGoalTimeseries } from "@/components/dashboard/site-pages/goal-timeseries-chart";
import type { GoalTimeseriesPoint } from "@/lib/edge-client";

const DAY_MS = 24 * 60 * 60 * 1_000;
const UTC_DAY_START = Date.parse("2024-01-01T00:00:00.000Z");

function point(timestampMs: number, total = 0): GoalTimeseriesPoint {
  return {
    timestampMs,
    sessions: { converted: 0, conversionRate: 0, total },
    visitors: { converted: 0, conversionRate: 0, total },
  };
}

describe("normalizeGoalTimeseries", () => {
  it("treats an exact UTC day boundary as exclusive", () => {
    const normalized = normalizeGoalTimeseries(
      [
        point(UTC_DAY_START),
        point(UTC_DAY_START + DAY_MS, 2),
        point(UTC_DAY_START + 2 * DAY_MS, 3),
      ],
      UTC_DAY_START,
      UTC_DAY_START + 2 * DAY_MS,
      "day",
      "UTC",
    );

    expect(normalized.map((item) => item.timestampMs)).toEqual([
      UTC_DAY_START,
      UTC_DAY_START + DAY_MS,
    ]);
    expect(normalized).toHaveLength(2);
  });

  it("defensively zero-fills a missing UTC day without adding the exclusive endpoint", () => {
    const normalized = normalizeGoalTimeseries(
      [point(UTC_DAY_START, 1)],
      UTC_DAY_START,
      UTC_DAY_START + 2 * DAY_MS,
      "day",
      "UTC",
    );

    expect(normalized).toHaveLength(2);
    expect(normalized[1]?.timestampMs).toBe(UTC_DAY_START + DAY_MS);
    expect(normalized[1]?.sessions).toEqual({
      converted: 0,
      rate: 0,
      total: 0,
    });
  });
});
