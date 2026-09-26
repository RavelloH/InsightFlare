import { describe, expect, it } from "vitest";

import { calculateQueryCost } from "@/lib/edge/analytics/application/cost";

const dayMs = 24 * 60 * 60 * 1000;

describe("analytics query cost", () => {
  it("keeps the legacy candidate-range cost when evaluation range is omitted", () => {
    expect(calculateQueryCost({ rangeMs: 7 * dayMs })).toBe(7);
    expect(
      calculateQueryCost({ rangeMs: 7 * dayMs, evaluationRangeMs: 7 * dayMs }),
    ).toBe(7);
  });

  it("charges additional cost for a wider history evaluation range", () => {
    expect(
      calculateQueryCost({ rangeMs: 7 * dayMs, evaluationRangeMs: 14 * dayMs }),
    ).toBe(10);
  });
});
