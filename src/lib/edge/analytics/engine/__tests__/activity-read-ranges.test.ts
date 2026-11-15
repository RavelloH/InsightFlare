import { describe, expect, it } from "vitest";

import { activityEvaluationReadRanges } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";

const range = (startMs: number, endExclusiveMs: number) => ({
  startMs,
  endExclusiveMs,
});

describe("activity guard temporal domains", () => {
  it("does not charge activities between separate report and expression windows", () => {
    expect(activityEvaluationReadRanges(range(30, 40), range(1, 10))).toEqual([
      range(1, 10),
      range(30, 40),
    ]);
  });

  it("counts overlaps once and keeps half-open adjoining windows continuous", () => {
    expect(activityEvaluationReadRanges(range(1, 10), range(5, 15))).toEqual([
      range(1, 15),
    ]);
    expect(activityEvaluationReadRanges(range(10, 20), range(1, 10))).toEqual([
      range(1, 20),
    ]);
    expect(activityEvaluationReadRanges(range(1, 20), range(5, 10))).toEqual([
      range(1, 20),
    ]);
    expect(activityEvaluationReadRanges(range(1, 20), range(1, 20))).toEqual([
      range(1, 20),
    ]);
  });

  it("ignores empty windows and does not mutate prepared time boundaries", () => {
    const candidate = Object.freeze(range(7, 7));
    const read = Object.freeze(range(1, 5));
    expect(activityEvaluationReadRanges(candidate, read)).toEqual([
      range(1, 5),
    ]);
    expect(activityEvaluationReadRanges(range(5, 1), candidate)).toEqual([]);
    expect(read).toEqual(range(1, 5));
  });

  it("retains exactly the union's activities without duplicates across a range grid", () => {
    for (let a = 0; a <= 4; a++)
      for (let b = a; b <= 5; b++)
        for (let c = 0; c <= 4; c++)
          for (let d = c; d <= 5; d++) {
            const merged = activityEvaluationReadRanges(
              range(a, b),
              range(c, d),
            );
            for (let time = 0; time <= 5; time++) {
              const expected =
                (a <= time && time < b) || (c <= time && time < d);
              expect(
                merged.filter(
                  (part) => part.startMs <= time && time < part.endExclusiveMs,
                ).length,
              ).toBe(expected ? 1 : 0);
            }
          }
  });
});
