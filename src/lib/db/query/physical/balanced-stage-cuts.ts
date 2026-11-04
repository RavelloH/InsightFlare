/**
 * Pure polynomial selector for cuts in one already-proved serial window
 * region. This module chooses among licenses; it never grants one.
 */
export interface BalancedStageCut {
  readonly node: object;
  readonly postorderIndex: number;
  readonly eligible: boolean;
}

export interface BalancedStageSelection {
  readonly selected: readonly BalancedStageCut[];
  readonly windowDepth: number;
  readonly stageDepth: number;
  readonly objective: readonly number[];
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareNumbers(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

/** Select cuts by lexicographically minimizing (max(W,M), W, M, cuts, tie). */
export function selectBalancedStageCuts(args: {
  readonly segmentWeights: readonly number[];
  readonly cuts: readonly BalancedStageCut[];
  readonly fixedWindowFloor?: number;
}): BalancedStageSelection {
  const { segmentWeights, cuts } = args;
  const fixedWindowFloor = args.fixedWindowFloor ?? 0;
  if (
    !Array.isArray(segmentWeights) ||
    segmentWeights.length === 0 ||
    !Array.isArray(cuts) ||
    cuts.length !== segmentWeights.length - 1 ||
    !validCount(fixedWindowFloor) ||
    segmentWeights.some((weight) => !validCount(weight))
  )
    throw new TypeError("invalid_balanced_stage_input");

  const nodeIds = new Set<object>();
  let previousPostorder = -1;
  for (const cut of cuts) {
    if (
      !cut ||
      typeof cut.node !== "object" ||
      cut.node === null ||
      nodeIds.has(cut.node) ||
      !Number.isSafeInteger(cut.postorderIndex) ||
      cut.postorderIndex <= previousPostorder ||
      typeof cut.eligible !== "boolean"
    )
      throw new TypeError("invalid_balanced_stage_cut");
    nodeIds.add(cut.node);
    previousPostorder = cut.postorderIndex;
  }

  const prefix = [0];
  for (const weight of segmentWeights) {
    const sum = prefix[prefix.length - 1]! + weight;
    if (!Number.isSafeInteger(sum))
      throw new TypeError("balanced_stage_weight_overflow");
    prefix.push(sum);
  }
  const segmentCount = segmentWeights.length;
  const eligibleIndexes = cuts.flatMap((cut, index) =>
    cut.eligible ? [index] : [],
  );
  const eligibleSuffixCounts = Array<number>(cuts.length + 1).fill(0);
  for (let index = cuts.length - 1; index >= 0; index--)
    eligibleSuffixCounts[index] =
      eligibleSuffixCounts[index + 1]! + Number(cuts[index]!.eligible);

  // dp[end][count] is the smallest prefix bottleneck for a path ending at
  // cut `end` with `count` selected cuts. Each transition adds one interval.
  const dp: Map<number, number>[] = Array.from(
    { length: cuts.length },
    () => new Map<number, number>(),
  );
  for (const end of eligibleIndexes) {
    dp[end]!.set(1, prefix[end + 1]!);
    for (const previous of eligibleIndexes) {
      if (previous >= end) break;
      for (const [count, depth] of dp[previous]!) {
        const interval = prefix[end + 1]! - prefix[previous + 1]!;
        const nextDepth = Math.max(depth, interval);
        const prior = dp[end]!.get(count + 1);
        if (prior === undefined || nextDepth < prior)
          dp[end]!.set(count + 1, nextDepth);
      }
    }
  }

  const minimumWindowByCount = new Map<number, number>([
    [0, Math.max(prefix[segmentCount]!, fixedWindowFloor)],
  ]);
  for (const end of eligibleIndexes) {
    const suffix = prefix[segmentCount]! - prefix[end + 1]!;
    for (const [count, prefixDepth] of dp[end]!) {
      const depth = Math.max(prefixDepth, suffix, fixedWindowFloor);
      const prior = minimumWindowByCount.get(count);
      if (prior === undefined || depth < prior)
        minimumWindowByCount.set(count, depth);
    }
  }

  const candidates: BalancedStageSelection[] = [
    {
      selected: [],
      windowDepth: minimumWindowByCount.get(0)!,
      stageDepth: 0,
      objective: [
        minimumWindowByCount.get(0)!,
        minimumWindowByCount.get(0)!,
        0,
        0,
      ],
    },
  ];

  // Recover the earliest stable-postorder path for every attainable cut
  // count at that count's minimum W. This is O(n^3), with no subset search.
  for (const [count, threshold] of minimumWindowByCount) {
    if (count === 0) continue;
    const minimumFurtherCuts = (
      start: number,
      memo: Map<number, number>,
    ): number => {
      const cached = memo.get(start);
      if (cached !== undefined) return cached;
      if (prefix[segmentCount]! - prefix[start]! <= threshold) {
        memo.set(start, 0);
        return 0;
      }
      let best = Number.POSITIVE_INFINITY;
      for (const next of eligibleIndexes) {
        if (next < start) continue;
        if (prefix[next + 1]! - prefix[start]! > threshold) break;
        best = Math.min(best, 1 + minimumFurtherCuts(next + 1, memo));
      }
      memo.set(start, best);
      return best;
    };

    const memo = new Map<number, number>();
    const selectedIndexes: number[] = [];
    let start = 0;
    let remaining = count;
    while (remaining > 0) {
      let selected = -1;
      for (const next of eligibleIndexes) {
        if (next < start) continue;
        if (prefix[next + 1]! - prefix[start]! > threshold) break;
        const tailMinimum = minimumFurtherCuts(next + 1, memo);
        const suffix = prefix[segmentCount]! - prefix[next + 1]!;
        if (
          tailMinimum <= remaining - 1 &&
          eligibleSuffixCounts[next + 1]! >= remaining - 1 &&
          (remaining > 1 || suffix <= threshold)
        ) {
          selected = next;
          break;
        }
      }
      if (selected < 0) break;
      selectedIndexes.push(selected);
      start = selected + 1;
      remaining--;
    }
    if (remaining !== 0) continue;
    const selected = selectedIndexes.map((index) => cuts[index]!);
    const tie = selected.map(({ postorderIndex }) => postorderIndex);
    const windowDepth = minimumWindowByCount.get(count)!;
    candidates.push({
      selected,
      windowDepth,
      stageDepth: count,
      objective: [
        Math.max(windowDepth, count),
        windowDepth,
        count,
        count,
        ...tie,
      ],
    });
  }

  let winner = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (compareNumbers(candidate.objective, winner.objective) < 0)
      winner = candidate;
  }
  return Object.freeze({
    selected: Object.freeze([...winner.selected]),
    windowDepth: winner.windowDepth,
    stageDepth: winner.stageDepth,
    objective: Object.freeze([...winner.objective]),
  });
}
