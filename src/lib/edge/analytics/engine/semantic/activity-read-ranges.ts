export interface ActivityReadRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

/**
 * The activity guard reads candidate ∪ evaluation, never their bounding span.
 * Merge overlaps so an activity is counted once; retain gaps so unrelated
 * history cannot consume the request's activity budget.
 */
export function activityEvaluationReadRanges(
  candidate: ActivityReadRange,
  read: ActivityReadRange,
): ActivityReadRange[] {
  const ranges = [candidate, read]
    .filter((range) => range.startMs < range.endExclusiveMs)
    .sort((left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endExclusiveMs: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.startMs > previous.endExclusiveMs) {
      merged.push({ ...range });
    } else if (range.endExclusiveMs > previous.endExclusiveMs) {
      previous.endExclusiveMs = range.endExclusiveMs;
    }
  }
  return merged;
}
