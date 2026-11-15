import {
  calibrateDuration,
  DURATION_PROTOCOL,
  durationFingerprint,
} from "./duration-contract";

interface FrozenCell {
  readonly identity: string;
  readonly windows: readonly (readonly number[])[];
  readonly budget?: ReturnType<typeof calibrateDuration>;
}

export interface DurationCalibration {
  readonly protocol: typeof DURATION_PROTOCOL;
  readonly context: Readonly<Record<string, unknown>>;
  readonly contextFingerprint: string;
  readonly cells: Readonly<Record<string, FrozenCell>>;
}

interface BaselineStatement {
  readonly sqlDurationSource: string;
  readonly sqlDurationMs: number;
  readonly durationRaw: {
    readonly timingsSqlDurationMs?: number;
    readonly duration?: number;
  };
  readonly rowsWritten: number;
}

interface BaselineSample {
  readonly status: string;
  readonly scenario: string;
  readonly kind: string;
  readonly window: number;
  readonly repetition: number;
  readonly identity: string;
  readonly sqlDurationMs: number;
  readonly value: unknown;
  readonly absoluteBudget: DurationReadBudget;
  readonly statementDetail: readonly BaselineStatement[];
}

export interface DurationReadBudget {
  readonly maxRowsRead: number;
  readonly maxStatements: number;
  readonly requestFingerprint: string;
}

function readBudget(value: DurationReadBudget): DurationReadBudget {
  if (
    !Number.isSafeInteger(value.maxRowsRead) ||
    value.maxRowsRead <= 0 ||
    !Number.isSafeInteger(value.maxStatements) ||
    value.maxStatements <= 0 ||
    !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
  )
    throw new Error("c01_duration_baseline_read_budget_invalid");
  return {
    maxRowsRead: value.maxRowsRead,
    maxStatements: value.maxStatements,
    requestFingerprint: value.requestFingerprint,
  };
}

/** Enforce archived read limits even if the candidate's budget code changes. */
export function assertDurationCandidateReadBudget(input: {
  readonly baseline: DurationReadBudget;
  readonly currentBudget: DurationReadBudget;
  readonly cost: {
    readonly rowsRead: number;
    readonly rowsWritten: number;
    readonly statements: number;
  };
}) {
  const baseline = readBudget(input.baseline);
  if (
    durationFingerprint(readBudget(input.currentBudget)) !==
    durationFingerprint(baseline)
  )
    throw new Error("c01_duration_candidate_read_budget_changed");
  const { rowsRead, rowsWritten, statements } = input.cost;
  if (
    !Number.isSafeInteger(rowsRead) ||
    rowsRead <= 0 ||
    rowsRead > baseline.maxRowsRead ||
    !Number.isSafeInteger(statements) ||
    statements <= 0 ||
    statements > baseline.maxStatements ||
    rowsWritten !== 0
  )
    throw new Error("c01_duration_candidate_read_budget_exceeded");
}

/** The archive's byte SHA is checked by the caller before this data is read. */
export interface DurationBaselineArchive {
  readonly provenance: {
    readonly frozenCalibration: { readonly sha256: string };
  };
  readonly evidence: {
    readonly frozenCalibration: DurationCalibration;
    readonly calibration: {
      readonly status: string;
      readonly phase: string;
      readonly contextFingerprint: string;
      readonly frozenCalibrationSha256: string;
      readonly samples: readonly BaselineSample[];
    };
  };
}

/**
 * Version-one frozen cells hash their timing source without retaining its name.
 * Read the source and old DTO from the separately SHA-pinned raw evidence; never
 * assume that a historical duration was the SQL-only metric.
 */
export function readDurationBaselineEvidence(input: {
  readonly frozen: DurationCalibration;
  readonly frozenSha256: string;
  readonly archive: DurationBaselineArchive;
}) {
  const { frozen, archive, frozenSha256 } = input;
  const report = archive.evidence.calibration;
  if (
    archive.provenance.frozenCalibration.sha256 !== frozenSha256 ||
    report.frozenCalibrationSha256 !== frozenSha256 ||
    durationFingerprint(archive.evidence.frozenCalibration) !==
      durationFingerprint(frozen) ||
    frozen.contextFingerprint !== durationFingerprint(frozen.context) ||
    report.contextFingerprint !== frozen.contextFingerprint ||
    report.status !== "passed" ||
    report.phase !== "calibrate" ||
    durationFingerprint(frozen.protocol) !==
      durationFingerprint(DURATION_PROTOCOL)
  )
    throw new Error("c01_duration_baseline_evidence_mismatch");

  return new Map(
    Object.entries(frozen.cells).map(([name, cell]) => {
      if (
        !cell.budget ||
        durationFingerprint(calibrateDuration(cell.windows)) !==
          durationFingerprint(cell.budget)
      )
        throw new Error("c01_duration_baseline_budget_mismatch");
      const samples = report.samples.filter(
        (sample) => sample.scenario === name && sample.kind === "measured",
      );
      const expectedCount =
        DURATION_PROTOCOL.windows * DURATION_PROTOCOL.repetitionsPerWindow;
      const positions = new Set<string>();
      const sources = new Set<string>();
      let valueFingerprint: string | undefined;
      let absoluteBudget: DurationReadBudget | undefined;
      for (const sample of samples) {
        const position = `${sample.window}/${sample.repetition}`;
        if (
          sample.status !== "passed" ||
          sample.identity !== cell.identity ||
          !Number.isInteger(sample.window) ||
          sample.window < 0 ||
          sample.window >= DURATION_PROTOCOL.windows ||
          !Number.isInteger(sample.repetition) ||
          sample.repetition < 0 ||
          sample.repetition >= DURATION_PROTOCOL.repetitionsPerWindow ||
          positions.has(position) ||
          cell.windows[sample.window]?.[sample.repetition] !==
            sample.sqlDurationMs ||
          !sample.statementDetail.length
        )
          throw new Error("c01_duration_baseline_samples_invalid");
        positions.add(position);
        const sampleBudget = readBudget(sample.absoluteBudget);
        if (
          absoluteBudget &&
          durationFingerprint(absoluteBudget) !==
            durationFingerprint(sampleBudget)
        )
          throw new Error("c01_duration_baseline_read_budget_changed");
        absoluteBudget = sampleBudget;
        let sum = 0;
        for (const statement of sample.statementDetail) {
          const raw =
            statement.sqlDurationSource === "timings.sql_duration_ms"
              ? statement.durationRaw.timingsSqlDurationMs
              : statement.sqlDurationSource === "duration"
                ? statement.durationRaw.duration
                : undefined;
          if (
            raw !== statement.sqlDurationMs ||
            !Number.isFinite(raw) ||
            statement.sqlDurationMs < 0 ||
            statement.rowsWritten !== 0
          )
            throw new Error("c01_duration_baseline_timing_invalid");
          sources.add(statement.sqlDurationSource);
          sum += statement.sqlDurationMs;
        }
        if (sum !== sample.sqlDurationMs || !Number.isFinite(sum))
          throw new Error("c01_duration_baseline_timing_invalid");
        const fingerprint = durationFingerprint(sample.value);
        if (valueFingerprint !== undefined && fingerprint !== valueFingerprint)
          throw new Error("c01_duration_baseline_dto_changed");
        valueFingerprint = fingerprint;
      }
      if (samples.length !== expectedCount || sources.size !== 1)
        throw new Error("c01_duration_baseline_samples_or_metric_mixed");
      return [
        name,
        {
          source: [...sources][0]!,
          value: samples[0]!.value,
          absoluteBudget: absoluteBudget!,
        },
      ] as const;
    }),
  );
}
