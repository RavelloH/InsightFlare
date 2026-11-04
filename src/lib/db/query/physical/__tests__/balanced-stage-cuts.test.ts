import { describe, expect, it } from "vitest";

import { selectBalancedStageCuts } from "@/lib/db/query/physical/balanced-stage-cuts";

function makeCuts(eligibility: readonly boolean[]) {
  return eligibility.map((eligible, index) => ({
    node: {},
    postorderIndex: index + 1,
    eligible,
  }));
}

function oracle(
  weights: readonly number[],
  cuts: ReturnType<typeof makeCuts>,
  floor: number,
) {
  const candidates: { score: number[]; selected: number[] }[] = [];
  for (let mask = 0; mask < 2 ** cuts.length; mask++) {
    const selected: number[] = [];
    let legal = true;
    for (let index = 0; index < cuts.length; index++) {
      if ((mask & (1 << index)) === 0) continue;
      if (!cuts[index]!.eligible) legal = false;
      selected.push(index);
    }
    if (!legal) continue;
    const groups: number[] = [];
    let group = weights[0]!;
    for (let index = 0; index < cuts.length; index++) {
      if (selected.includes(index)) {
        groups.push(group);
        group = 0;
      }
      group += weights[index + 1]!;
    }
    groups.push(group);
    const windowDepth = Math.max(floor, ...groups);
    const stageDepth = selected.length;
    candidates.push({
      selected,
      score: [
        Math.max(windowDepth, stageDepth),
        windowDepth,
        stageDepth,
        selected.length,
        ...selected.map((index) => cuts[index]!.postorderIndex),
      ],
    });
  }
  candidates.sort((left, right) => {
    const length = Math.min(left.score.length, right.score.length);
    for (let index = 0; index < length; index++) {
      if (left.score[index] !== right.score[index])
        return left.score[index]! - right.score[index]!;
    }
    return left.score.length - right.score.length;
  });
  return candidates[0]!;
}

describe("balanced stage cut selector", () => {
  it("matches an independent small exhaustive oracle", () => {
    const examples = [
      {
        weights: [1, 1, 1, 1, 1],
        eligible: [true, true, true, true],
        floor: 0,
      },
      {
        weights: [1, 3, 1, 2, 1],
        eligible: [true, false, true, true],
        floor: 1,
      },
      { weights: [0, 4, 0, 1], eligible: [false, true, true], floor: 2 },
      {
        weights: [2, 0, 3, 1, 2, 0],
        eligible: [true, true, false, true, true],
        floor: 4,
      },
    ] as const;

    for (const example of examples) {
      const cuts = makeCuts(example.eligible);
      const expected = oracle(example.weights, cuts, example.floor);
      const actual = selectBalancedStageCuts({
        segmentWeights: example.weights,
        cuts,
        fixedWindowFloor: example.floor,
      });
      expect(actual.selected.map((cut) => cuts.indexOf(cut))).toEqual(
        expected.selected,
      );
      expect(actual.windowDepth).toBe(expected.score[1]);
      expect(actual.objective).toEqual(expected.score);
    }
  });

  it("chooses zero cuts when they win and preserves stable ties", () => {
    const noImprovement = makeCuts([true, true]);
    expect(
      selectBalancedStageCuts({
        segmentWeights: [1, 0, 0],
        cuts: noImprovement,
      }).selected,
    ).toEqual([]);

    const cuts = makeCuts([true, true]);
    const tied = selectBalancedStageCuts({
      segmentWeights: [1, 0, 1],
      cuts,
    });
    expect(tied.selected.map((cut) => cuts.indexOf(cut))).toEqual([0]);
  });

  it("rejects malformed weights, cut order, and region shapes", () => {
    const cuts = makeCuts([true]);
    expect(() =>
      selectBalancedStageCuts({ segmentWeights: [1], cuts }),
    ).toThrow("invalid_balanced_stage_input");
    expect(() =>
      selectBalancedStageCuts({ segmentWeights: [-1, 1], cuts }),
    ).toThrow("invalid_balanced_stage_input");
    expect(() =>
      selectBalancedStageCuts({
        segmentWeights: [1, 1],
        cuts: [cuts[0]!, { node: {}, postorderIndex: 0, eligible: true }],
      }),
    ).toThrow("invalid_balanced_stage_input");
  });
});
