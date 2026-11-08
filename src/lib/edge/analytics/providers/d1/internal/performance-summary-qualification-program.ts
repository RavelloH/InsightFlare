import type { QueryInput } from "@/lib/edge/analytics/contract";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  PERFORMANCE_SUMMARY_OUTPUT_FIELDS,
  PERFORMANCE_SUMMARY_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  buildPerformanceSummaryQualificationPlan,
  PERFORMANCE_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/performance-summary-qualification-plan";
import {
  type DeferredPerformanceSummaryQualification,
  deferredPerformanceSummaryQualificationFromQuery,
  isDeferredPerformanceSummaryQualificationRequest,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilationEvidence,
} from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

export type PerformanceSummaryQualificationExecution =
  | {
      readonly kind: "executed";
      readonly row: Readonly<Record<string, unknown>>;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
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
    throw new Error(`performance_summary_qualification_output:${outputId}`);
  return matches[0]!;
}

function exactRowKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

type PerformanceSummaryProgramInput = {
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: DeferredPerformanceSummaryQualification;
};

function compileProgram(input: PerformanceSummaryProgramInput) {
  const deferred = input.deferred;
  if (!isDeferredPerformanceSummaryQualificationRequest(deferred))
    throw new Error("performance_summary_qualification_request_invalid");
  if (
    deferredPerformanceSummaryQualificationFromQuery(input.query) !== deferred
  )
    throw new Error("performance_summary_qualification_request_changed");
  if (deferred.configuration.mode !== "summary")
    throw new Error("performance_summary_qualification_request_changed");
  const qualification = buildPerformanceSummaryQualificationPlan({
    siteId: deferred.qualification.siteId,
    queryTime: deferred.qualification.requestTime,
    filters: deferred.qualification.filters,
    ...(deferred.qualification.performanceFilterMode === "allow-whole-filter"
      ? { filterMode: deferred.qualification.performanceFilterMode }
      : {}),
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
    ...("eventCandidateReportProjection" in deferred.qualification &&
    deferred.qualification.eventCandidateReportProjection === "page-visits"
      ? { eventCandidateReportProjection: "page-visits" as const }
      : {}),
  });
  if (
    qualification.reportOutputIds.length !== 1 ||
    qualification.reportOutputIds[0] !== PERFORMANCE_SUMMARY_OUTPUT_ID
  )
    throw new Error("performance_summary_qualification_plan_identity_invalid");
  const report = exactOutput(
    qualification.plan.outputs,
    PERFORMANCE_SUMMARY_OUTPUT_ID,
  );
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    PERFORMANCE_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
  );
  return {
    deferred,
    compilation: compileQualificationProgramEnvelope({
      qualification,
      siteId: deferred.qualification.siteId,
      reports: [
        {
          output: report,
          fields: PERFORMANCE_SUMMARY_OUTPUT_FIELDS,
          rowType: "performance-summary",
        },
      ],
      controlsOutput,
      reportFields: PERFORMANCE_SUMMARY_OUTPUT_FIELDS,
      controlFields: controlsOutput.fields.map(({ name }) => name),
      ordering: [],
      errorPrefix: "performance_summary_qualification",
      fallbackTag: "analytics.performance_summary_qualification",
      signal: deferred.qualification.signal,
    }),
  };
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredPerformanceSummaryQualification,
  evidence: QualificationEnvelopeCompilationEvidence,
): PerformanceSummaryQualificationExecution {
  const expectedFields = [
    "rowKind",
    "outputId",
    ...PERFORMANCE_SUMMARY_OUTPUT_FIELDS,
    ...evidence.controlFields,
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  if (
    controlRows.length !== 1 ||
    !exactRowKeys(controlRows[0]!, expectedFields) ||
    controlRows[0]!.outputId !== evidence.controlOutputId
  )
    throw new Error("performance_summary_qualification_control_row_invalid");

  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    PERFORMANCE_SUMMARY_OUTPUT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error("performance_summary_qualification_control_kind_mismatch");

  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `performance_summary_qualification_control_invalid:${field}`,
  });
  const reportRows = rows.filter((row) => row.rowKind === "report");
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("performance_summary_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback") return judgment;

  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error("performance_summary_qualification_envelope_kind_invalid");
  if (reportRows.length !== 1)
    throw new Error(
      "performance_summary_qualification_report_cardinality_invalid",
    );
  const report = reportRows[0]!;
  if (
    !exactRowKeys(report, expectedFields) ||
    report.outputId !== PERFORMANCE_SUMMARY_OUTPUT_ID ||
    evidence.controlFields.some((field) => report[field] !== null)
  )
    throw new Error("performance_summary_qualification_report_row_invalid");

  return { kind: "executed", row: report, evidence };
}

export function compilePerformanceSummaryQualificationProgram(
  input: PerformanceSummaryProgramInput,
) {
  return compileProgram(input).compilation;
}

export async function executePerformanceSummaryQualificationProgram(
  input: PerformanceSummaryProgramInput & {
    readonly env: Env;
    readonly diagnostics?: D1ReadDiagnostics;
  },
): Promise<PerformanceSummaryQualificationExecution> {
  const { deferred, compilation } = compileProgram(input);
  if (compilation.kind === "unavailable") {
    if (input.diagnostics)
      input.diagnostics.advancedCountSqlFallbackReason =
        compilation.fallbackReason;
    return compilation;
  }
  const rows = await executeQualificationQuery(
    deferred.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query,
        input.diagnostics,
      ),
  );
  const execution = decodeRows(rows, deferred, compilation.evidence);
  if (execution.kind === "fallback" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  return execution;
}

export type PerformanceSummaryQualificationPlanEvidence =
  AnalyticsQualificationPlan;
