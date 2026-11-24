import { describe, expect, it } from "vitest";

import { pulseBaseline, pulseLevel } from "./site-pulse-heatmap";

describe("site pulse statistical fading", () => {
  it("includes zero days in sparse site baselines", () => {
    const values = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 1 : 0));
    expect(pulseBaseline(values)).toBeCloseTo(0.2);
    expect(pulseLevel(0, pulseBaseline(values))).toBe(0);
    expect(pulseLevel(1, pulseBaseline(values))).toBe(0);
    expect(pulseLevel(2, pulseBaseline(values))).toBeGreaterThan(0);
  });

  it("retains a robust median for busy sites", () => {
    expect(pulseBaseline([100, 100, 90, 0, 2000])).toBe(100);
    expect(pulseLevel(0, 100)).toBe(-4);
    expect(pulseLevel(100, 100)).toBe(0);
    expect(pulseLevel(200, 100)).toBeGreaterThan(0);
  });

  it("makes low-volume zero days neutral and increases fading with evidence", () => {
    expect([0.1, 0.5, 1, 2].map((mean) => pulseLevel(0, mean))).toEqual([
      0, 0, 0, 0,
    ]);
    expect([3, 5, 10].map((mean) => pulseLevel(0, mean))).toEqual([-2, -3, -4]);
    expect(pulseBaseline([0, 0, 0])).toBe(0);
    expect(pulseLevel(0, 0)).toBe(0);
    expect(pulseLevel(0, Number.NaN)).toBe(0);
  });
});
