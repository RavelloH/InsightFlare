import { createHash } from "node:crypto";

export const DURATION_PROTOCOL = {
  version: 1,
  windows: 3,
  repetitionsPerWindow: 7,
  warmupsPerWindow: 1,
  windowGapMs: 60000,
  validationRepetitions: 5,
  medianFactor: 1.5,
  madFactor: 6,
  medianFloorMs: 10,
  tailFactor: 2,
  tailAdditionMs: 25,
} as const;

export function durationFingerprint(value: unknown): string {
  const ancestors = new Set<object>();
  function stable(input: unknown): unknown {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "object" && input !== null && ancestors.has(input))
      throw new Error("c01_duration_non_json_identity");
    if (Array.isArray(input)) {
      ancestors.add(input);
      try {
        return input.map(stable);
      } finally {
        ancestors.delete(input);
      }
    }
    if (
      typeof input === "object" &&
      Object.getPrototypeOf(input) === Object.prototype
    ) {
      ancestors.add(input);
      try {
        return Object.fromEntries(
          Object.keys(input)
            .sort()
            .map((key) => [
              key,
              stable((input as Record<string, unknown>)[key]),
            ]),
        );
      } finally {
        ancestors.delete(input);
      }
    }
    throw new Error("c01_duration_non_json_identity");
  }
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

/** Pin the candidate window while preserving the original fixture contract. */
export function validateDurationContext(input: {
  readonly phase: "validate" | "candidate";
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly expectedCandidateSourceSha256?: string;
}) {
  const baselineSourceSha256 = durationFingerprint(input.baseline.sources);
  const candidateSourceSha256 = durationFingerprint(input.candidate.sources);
  if (input.phase === "validate") {
    if (
      durationFingerprint(input.baseline) !==
      durationFingerprint(input.candidate)
    )
      throw new Error("c01_duration_frozen_context_changed");
  } else {
    if (
      !/^[a-f0-9]{64}$/.test(input.expectedCandidateSourceSha256 ?? "") ||
      input.expectedCandidateSourceSha256 !== candidateSourceSha256
    )
      throw new Error(
        "c01_duration_candidate_source_sha_required_or_mismatched",
      );
    const withoutSources = (context: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(context).filter(([key]) => key !== "sources"),
      );
    if (
      durationFingerprint(withoutSources(input.baseline)) !==
      durationFingerprint(withoutSources(input.candidate))
    )
      throw new Error("c01_duration_candidate_fixture_or_request_changed");
  }
  return { baselineSourceSha256, candidateSourceSha256 };
}
function checked(values: readonly number[], length: number): number[] {
  if (
    values.length !== length ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("c01_duration_invalid_samples");
  return [...values].sort((a, b) => a - b);
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function calibrateDuration(windows: readonly (readonly number[])[]) {
  if (windows.length !== DURATION_PROTOCOL.windows)
    throw new Error("c01_duration_window_count");
  const ordered = windows.map((values) =>
    checked(values, DURATION_PROTOCOL.repetitionsPerWindow),
  );
  const medians = ordered.map(median);
  const pooled = ordered.flat();
  const pooledMedian = median(pooled);
  const mad = median(pooled.map((value) => Math.abs(value - pooledMedian)));
  const m = Math.max(...medians);
  if (m > 1.5 * Math.min(...medians) + 10 || mad > m / 3 + 5)
    throw new Error("c01_duration_calibration_unstable");
  const u = Math.max(...ordered.map((values) => values[5]!));
  return {
    windowMediansMs: medians,
    pooledMedianMs: pooledMedian,
    medianAbsoluteDeviationMs: mad,
    empiricalSixthOfSevenMaxMs: u,
    medianCeilingMs: Math.ceil(1.5 * m + Math.max(10, 6 * mad)),
    tailCeilingMs: Math.ceil(2 * u + 25),
  };
}
export function validateDuration(
  budget: ReturnType<typeof calibrateDuration>,
  samples: readonly number[],
) {
  const sorted = checked(samples, DURATION_PROTOCOL.validationRepetitions);
  if (
    ![budget.medianCeilingMs, budget.tailCeilingMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("c01_duration_invalid_budget");
  const actualMedianMs = median(sorted);
  const tailExceedances = sorted.filter(
    (value) => value > budget.tailCeilingMs,
  ).length;
  if (actualMedianMs > budget.medianCeilingMs || tailExceedances > 1)
    throw new Error("c01_duration_budget_exceeded");
  return {
    actualMedianMs,
    tailExceedances,
    medianCeilingMs: budget.medianCeilingMs,
    tailCeilingMs: budget.tailCeilingMs,
  };
}
