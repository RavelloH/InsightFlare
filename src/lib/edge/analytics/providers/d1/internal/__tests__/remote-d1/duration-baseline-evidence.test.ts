import { expect, it } from "vitest";

import {
  assertDurationCandidateReadBudget,
  type DurationBaselineArchive,
  readDurationBaselineEvidence,
} from "./duration-baseline-evidence";
import {
  calibrateDuration,
  DURATION_PROTOCOL,
  durationFingerprint,
} from "./duration-contract";

function evidenceFixture() {
  const windows = Array.from({ length: 3 }, () => [10, 11, 12, 13, 14, 15, 16]);
  const context = { sources: { "query.ts": "old" }, fixture: "seed" };
  const frozen = {
    protocol: DURATION_PROTOCOL,
    context,
    contextFingerprint: durationFingerprint(context),
    cells: {
      report: {
        identity: "sql-and-params",
        windows,
        budget: calibrateDuration(windows),
      },
    },
  };
  const frozenSha256 = "frozen-bytes-sha";
  const archive: DurationBaselineArchive = {
    provenance: { frozenCalibration: { sha256: frozenSha256 } },
    evidence: {
      frozenCalibration: frozen,
      calibration: {
        status: "passed",
        phase: "calibrate",
        contextFingerprint: frozen.contextFingerprint,
        frozenCalibrationSha256: frozenSha256,
        samples: windows.flatMap((values, window) =>
          values.map((duration, repetition) => ({
            status: "passed",
            scenario: "report",
            kind: "measured",
            window,
            repetition,
            identity: "sql-and-params",
            sqlDurationMs: duration,
            value: { items: [{ id: "old-result" }] },
            absoluteBudget: {
              maxRowsRead: 100,
              maxStatements: 2,
              requestFingerprint: "a".repeat(64),
            },
            statementDetail: [
              {
                sqlDurationSource: "timings.sql_duration_ms",
                sqlDurationMs: duration,
                durationRaw: {
                  timingsSqlDurationMs: duration,
                  duration: duration + 100,
                },
                rowsWritten: 0,
              },
            ],
          })),
        ),
      },
    },
  };
  return { frozen, frozenSha256, archive };
}

it("recovers the actual baseline timing field and old DTO from complete fixed evidence", () => {
  const input = evidenceFixture();
  const before = JSON.stringify(input);
  expect(readDurationBaselineEvidence(input).get("report")).toEqual({
    source: "timings.sql_duration_ms",
    value: { items: [{ id: "old-result" }] },
    absoluteBudget: {
      maxRowsRead: 100,
      maxStatements: 2,
      requestFingerprint: "a".repeat(64),
    },
  });
  expect(JSON.stringify(input)).toBe(before);
});

it("keeps the archived read and statement ceilings when candidate source changes", () => {
  const input = evidenceFixture();
  const baseline =
    readDurationBaselineEvidence(input).get("report")!.absoluteBudget;
  const cost = { rowsRead: 100, rowsWritten: 0, statements: 2 };
  expect(() =>
    assertDurationCandidateReadBudget({
      baseline,
      currentBudget: baseline,
      cost,
    }),
  ).not.toThrow();
  for (const currentBudget of [
    { ...baseline, maxRowsRead: 101 },
    { ...baseline, maxStatements: 3 },
    { ...baseline, requestFingerprint: "b".repeat(64) },
  ])
    expect(() =>
      assertDurationCandidateReadBudget({ baseline, currentBudget, cost }),
    ).toThrow("read_budget_changed");
  for (const invalidCost of [
    { ...cost, rowsRead: 101 },
    { ...cost, statements: 3 },
    { ...cost, rowsWritten: 1 },
    { ...cost, rowsRead: NaN },
  ])
    expect(() =>
      assertDurationCandidateReadBudget({
        baseline,
        currentBudget: baseline,
        cost: invalidCost,
      }),
    ).toThrow("read_budget_exceeded");
  const report = input.archive.evidence.calibration;
  const first = report.samples[0]!;
  expect(() =>
    readDurationBaselineEvidence({
      ...input,
      archive: {
        ...input.archive,
        evidence: {
          ...input.archive.evidence,
          calibration: {
            ...report,
            samples: [
              { ...first, absoluteBudget: { ...baseline, maxRowsRead: 101 } },
              ...report.samples.slice(1),
            ],
          },
        },
      },
    }),
  ).toThrow("baseline_read_budget_changed");
});

it("rejects changed frozen budgets, provenance and incomplete or duplicate observations", () => {
  const budget = evidenceFixture();
  budget.frozen.cells.report.budget.medianCeilingMs += 1;
  expect(() => readDurationBaselineEvidence(budget)).toThrow("budget_mismatch");
  const provenance = evidenceFixture();
  expect(() =>
    readDurationBaselineEvidence({ ...provenance, frozenSha256: "other" }),
  ).toThrow("evidence_mismatch");
  const missing = evidenceFixture();
  const report = missing.archive.evidence.calibration;
  expect(() =>
    readDurationBaselineEvidence({
      ...missing,
      archive: {
        ...missing.archive,
        evidence: {
          ...missing.archive.evidence,
          calibration: { ...report, samples: report.samples.slice(1) },
        },
      },
    }),
  ).toThrow("samples_or_metric_mixed");
  const duplicate = evidenceFixture();
  const duplicateReport = duplicate.archive.evidence.calibration;
  expect(() =>
    readDurationBaselineEvidence({
      ...duplicate,
      archive: {
        ...duplicate.archive,
        evidence: {
          ...duplicate.archive.evidence,
          calibration: {
            ...duplicateReport,
            samples: [...duplicateReport.samples, duplicateReport.samples[0]!],
          },
        },
      },
    }),
  ).toThrow("samples_invalid");
});

it("rejects mixed metric sources, altered raw times and historical DTO drift", () => {
  for (const mutation of ["source", "raw", "dto"] as const) {
    const input = evidenceFixture();
    const archive = structuredClone(input.archive) as DurationBaselineArchive;
    const samples = archive.evidence.calibration.samples;
    const first = samples[0]!;
    const replacement =
      mutation === "dto"
        ? { ...first, value: { items: [] } }
        : {
            ...first,
            statementDetail: [
              {
                ...first.statementDetail[0]!,
                ...(mutation === "source"
                  ? {
                      sqlDurationSource: "duration",
                      durationRaw: { duration: first.sqlDurationMs },
                    }
                  : { durationRaw: { timingsSqlDurationMs: 999 } }),
              },
            ],
          };
    expect(() =>
      readDurationBaselineEvidence({
        ...input,
        archive: {
          ...archive,
          evidence: {
            ...archive.evidence,
            calibration: {
              ...archive.evidence.calibration,
              samples: [replacement, ...samples.slice(1)],
            },
          },
        },
      }),
    ).toThrow(
      mutation === "source"
        ? "metric_mixed"
        : mutation === "raw"
          ? "timing_invalid"
          : "dto_changed",
    );
  }
});
