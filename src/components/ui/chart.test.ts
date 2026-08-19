import { describe, expect, it } from "vitest";

import {
  calculateChartYAxisWidth,
  createChartNumberFormatter,
} from "@/components/ui/chart";

describe("calculateChartYAxisWidth", () => {
  it("reserves only the space required by formatted numeric labels", () => {
    expect(calculateChartYAxisWidth(["0", "34,000"], 4)).toBe(55);
  });

  it("uses a narrow axis for an empty series instead of Recharts' wide default", () => {
    expect(calculateChartYAxisWidth([], 4)).toBe(24);
  });

  it("formats numeric ticks with locale-aware separators", () => {
    expect(createChartNumberFormatter("en-US").format(34000)).toBe("34,000");
  });
});
