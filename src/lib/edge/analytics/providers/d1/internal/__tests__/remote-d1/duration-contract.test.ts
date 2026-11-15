import { expect, it } from "vitest";

import {
  calibrateDuration,
  durationFingerprint,
  validateDuration,
  validateDurationContext,
} from "./duration-contract";

const windows = [
  [10, 11, 12, 13, 14, 15, 100],
  [11, 12, 13, 14, 15, 16, 101],
  [12, 13, 14, 15, 16, 17, 102],
];
it("pins the preregistered robust ceilings without using the largest outlier", () => {
  const budget = calibrateDuration(windows);
  expect(budget).toMatchObject({
    windowMediansMs: [13, 14, 15],
    medianAbsoluteDeviationMs: 2,
    medianCeilingMs: 35,
    tailCeilingMs: 59,
  });
  expect(validateDuration(budget, [13, 14, 15, 16, 100]).tailExceedances).toBe(
    1,
  );
  expect(() => validateDuration(budget, [13, 14, 15, 100, 101])).toThrow(
    "budget_exceeded",
  );
  expect(() => validateDuration(budget, [36, 36, 36, 36, 36])).toThrow(
    "budget_exceeded",
  );
});
it("rejects unstable windows and incomplete or nonfinite samples", () => {
  expect(() =>
    calibrateDuration([
      windows[0]!,
      windows[1]!,
      [100, 100, 100, 100, 100, 100, 100],
    ]),
  ).toThrow("unstable");
  expect(() => calibrateDuration([windows[0]!])).toThrow("window_count");
  expect(() =>
    calibrateDuration([windows[0]!, windows[1]!, [1, 2, 3, 4, 5, 6, NaN]]),
  ).toThrow("invalid_samples");
});
it("canonicalizes request/SQL parameter identity and refuses unsupported JSON", () => {
  expect(durationFingerprint({ b: [1, "1"], a: 2 })).toBe(
    durationFingerprint({ a: 2, b: [1, "1"] }),
  );
  expect(durationFingerprint({ a: 1 })).not.toBe(
    durationFingerprint({ a: "1" }),
  );
  expect(() => durationFingerprint({ a: undefined })).toThrow("non_json");
});

it("pins a changed candidate source without replacing the historical budget context", () => {
  const baseline = {
    visits: 10000,
    fixtureSeedFingerprint: "seed",
    databaseFingerprint: "database",
    requests: { report: "request" },
    sources: { "query.ts": "old" },
  };
  const candidate = { ...baseline, sources: { "query.ts": "new" } };
  expect(() =>
    validateDurationContext({ phase: "validate", baseline, candidate }),
  ).toThrow("frozen_context_changed");
  expect(() =>
    validateDurationContext({ phase: "candidate", baseline, candidate }),
  ).toThrow("source_sha_required_or_mismatched");
  const expectedCandidateSourceSha256 = durationFingerprint(candidate.sources);
  expect(
    validateDurationContext({
      phase: "candidate",
      baseline,
      candidate,
      expectedCandidateSourceSha256,
    }),
  ).toEqual({
    baselineSourceSha256: durationFingerprint(baseline.sources),
    candidateSourceSha256: expectedCandidateSourceSha256,
  });
  for (const changed of [
    { visits: 2000 },
    { fixtureSeedFingerprint: "other-seed" },
    { databaseFingerprint: "other-database" },
    { requests: { report: "other-request" } },
    { undeclaredContext: true },
  ])
    expect(() =>
      validateDurationContext({
        phase: "candidate",
        baseline,
        candidate: { ...candidate, ...changed },
        expectedCandidateSourceSha256,
      }),
    ).toThrow("fixture_or_request_changed");
  expect(() =>
    validateDurationContext({
      phase: "candidate",
      baseline,
      candidate,
      expectedCandidateSourceSha256: durationFingerprint(baseline.sources),
    }),
  ).toThrow("source_sha_required_or_mismatched");
  expect(
    validateDurationContext({
      phase: "validate",
      baseline,
      candidate: baseline,
    }),
  ).toEqual({
    baselineSourceSha256: durationFingerprint(baseline.sources),
    candidateSourceSha256: durationFingerprint(baseline.sources),
  });
});
