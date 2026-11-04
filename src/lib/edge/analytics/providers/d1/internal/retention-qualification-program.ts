import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import {
  buildJourneyRetentionQualificationPlan,
  JOURNEY_RETENTION_QUALIFICATION_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-retention-qualification-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  deferredEventQualificationFromQuery,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  assertRetentionQualificationRequest,
  type DeferredRetentionQualification,
  deferredRetentionQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-request";
import type { Env } from "@/lib/edge/types";

import type { QueryWindow } from "./core";
import { buildTimeBuckets, queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  type RetentionResult,
  retentionResultFromRows,
} from "./journey-retention";
import type { QualificationEnvelopeCompilationEvidence } from "./qualification-program-envelope";
import { compileQualificationProgramEnvelope } from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

function requestWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

const ERROR_PREFIX = "retention_qualification";
const REPORT_FIELDS = ["cohortBucket", "visitBucket", "visitors"] as const;
const REPORT_ROW_TYPE = "journey-retention";

export type RetentionQualificationExecution =
  | {
      readonly kind: "executed";
      readonly result: RetentionResult;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`${ERROR_PREFIX}_output:${outputId}`);
  return matches[0]!;
}

function compileProgram(input: {
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: DeferredRetentionQualification;
}) {
  const request = assertRetentionQualificationRequest(
    input.deferred,
    input.query,
  );
  const qualification = request.qualification;
  if (
    !isDeferredEventQualification(qualification) ||
    qualification.operation !== "retention" ||
    deferredEventQualificationFromQuery(input.query, "retention") !==
      qualification ||
    deferredRetentionQualificationFromQuery(input.query) !== request
  )
    throw new Error(`${ERROR_PREFIX}_request_invalid`);

  const plan = buildJourneyRetentionQualificationPlan({
    siteId: qualification.siteId,
    queryTime: qualification.requestTime,
    filters: qualification.filters,
    scopePlan: qualification.metadata.plan,
    count: qualification.countInput,
    granularity: request.configuration.granularity,
    filterMode: request.filterMode,
  });
  const report = exactOutput(
    plan.plan.outputs,
    JOURNEY_RETENTION_QUALIFICATION_OUTPUT,
  );
  const controlsOutput = exactOutput(
    plan.plan.outputs,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  return {
    request,
    qualification,
    compilation: compileQualificationProgramEnvelope({
      qualification: plan,
      siteId: qualification.siteId,
      reports: [
        { output: report, fields: REPORT_FIELDS, rowType: REPORT_ROW_TYPE },
      ],
      controlsOutput,
      reportFields: REPORT_FIELDS,
      controlFields: controlsOutput.fields.map(({ name }) => name),
      ordering: [
        {
          outputId: JOURNEY_RETENTION_QUALIFICATION_OUTPUT,
          field: "cohortBucket",
          direction: "asc",
          nulls: "first",
        },
        {
          outputId: JOURNEY_RETENTION_QUALIFICATION_OUTPUT,
          field: "visitBucket",
          direction: "asc",
          nulls: "first",
        },
      ],
      errorPrefix: ERROR_PREFIX,
      fallbackTag: "analytics.retention_qualification",
      signal: qualification.signal,
    }),
  };
}

function ownRecordRows(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown>[] {
  if (!Array.isArray(input))
    throw new Error(`${ERROR_PREFIX}_envelope_rows_invalid`);
  const expected = ["rowKind", "outputId", ...REPORT_FIELDS, ...fields].sort();
  return input.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    }
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      [...keys].sort().some((key, index) => key !== expected[index])
    )
      throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
    const row: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
      row[key] = descriptor.value;
    }
    return row;
  });
}

function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredRetentionQualification;
  readonly evidence: QualificationEnvelopeCompilationEvidence;
}):
  | RetentionQualificationExecution
  | Extract<RetentionQualificationExecution, { readonly kind: "fallback" }> {
  const { rows, request, evidence } = input;
  const expectedFields = [
    "rowKind",
    "outputId",
    ...REPORT_FIELDS,
    ...evidence.controlFields,
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  if (
    controlRows.length !== 1 ||
    controlRows[0]!.outputId !== evidence.controlOutputId ||
    !exactKeys(controlRows[0]!, expectedFields)
  )
    throw new Error(`${ERROR_PREFIX}_control_row_invalid`);
  const control = controlRows[0]!;
  if (
    control.entityKind !== request.qualification.countInput.scope ||
    REPORT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error(`${ERROR_PREFIX}_control_kind_mismatch`);
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) => `${ERROR_PREFIX}_control_invalid:${field}`,
  });
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error(`${ERROR_PREFIX}_envelope_kind_invalid`);
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () => new Error(`${ERROR_PREFIX}_gate_violation`),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback") return judgment;

  const previous = { cohortBucket: -1, visitBucket: -1 };
  const pairs = new Set<string>();
  const bucketCount = buildTimeBuckets(
    requestWindow(request.qualification.requestTime),
    request.configuration.granularity,
  ).length;
  const sanitized: Record<string, unknown>[] = [];
  for (const row of reportRows) {
    if (
      row.outputId !== JOURNEY_RETENTION_QUALIFICATION_OUTPUT ||
      !exactKeys(row, expectedFields) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(`${ERROR_PREFIX}_report_row_invalid`);
    const cohortBucket = row.cohortBucket;
    const visitBucket = row.visitBucket;
    const visitors = row.visitors;
    if (
      typeof cohortBucket !== "number" ||
      !Number.isSafeInteger(cohortBucket) ||
      cohortBucket < 0 ||
      cohortBucket >= bucketCount ||
      typeof visitBucket !== "number" ||
      !Number.isSafeInteger(visitBucket) ||
      visitBucket < cohortBucket ||
      visitBucket >= bucketCount ||
      typeof visitors !== "number" ||
      !Number.isSafeInteger(visitors) ||
      visitors <= 0
    )
      throw new Error(`${ERROR_PREFIX}_report_value_invalid`);
    const pair = `${cohortBucket}:${visitBucket}`;
    if (
      pairs.has(pair) ||
      cohortBucket < previous.cohortBucket ||
      (cohortBucket === previous.cohortBucket &&
        visitBucket <= previous.visitBucket)
    )
      throw new Error(`${ERROR_PREFIX}_report_order_or_pair_invalid`);
    pairs.add(pair);
    previous.cohortBucket = cohortBucket;
    previous.visitBucket = visitBucket;
    sanitized.push({ cohortBucket, visitBucket, visitors });
  }
  return {
    kind: "executed",
    result: retentionResultFromRows(
      requestWindow(request.qualification.requestTime),
      request.configuration.granularity,
      sanitized,
    ),
    evidence,
    reportRowCount: sanitized.length,
    controlRowCount: 1,
  };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const required = [...expected].sort();
  return (
    keys.length === required.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys].sort().every((key, index) => key === required[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

export function compileRetentionQualificationProgram(input: {
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: DeferredRetentionQualification;
}) {
  return compileProgram(input).compilation;
}

export async function executeRetentionQualificationProgram(input: {
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: DeferredRetentionQualification;
  readonly env: Env;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<RetentionQualificationExecution> {
  const { request, qualification, compilation } = compileProgram(input);
  if (compilation.kind === "unavailable") return compilation;
  const rawRows = await executeQualificationQuery(qualification.signal, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      compilation.query,
      input.diagnostics,
    ),
  );
  const rows = ownRecordRows(rawRows, compilation.evidence.controlFields);
  return decodeRows({ rows, request, evidence: compilation.evidence });
}
