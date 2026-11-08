import type { QueryInput } from "@/lib/edge/analytics/contract";
import type {
  Interval,
  PerformanceMetricKey,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
  PERFORMANCE_METRICS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  buildPerformanceTimeseriesQualificationPlan,
  PERFORMANCE_TIMESERIES_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/performance-timeseries-qualification-plan";
import {
  type DeferredPerformanceSummaryQualification,
  deferredPerformanceSummaryQualificationFromQuery,
  isDeferredPerformanceSummaryQualificationRequest,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  buildTimeBuckets,
  type PerformanceTrendPointRow,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import { mapPerformanceTrendReportRows } from "./performance";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilation,
  type QualificationEnvelopeCompilationEvidence,
} from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

export type PerformanceTimeseriesQualificationCompilation =
  QualificationEnvelopeCompilation;

export type PerformanceTimeseriesQualificationExecution =
  | {
      readonly kind: "executed";
      readonly trends: Record<PerformanceMetricKey, PerformanceTrendPointRow[]>;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

interface PerformanceTimeseriesProgramInput {
  readonly query: QueryInput & Record<string, unknown>;
  readonly deferred: DeferredPerformanceSummaryQualification;
}

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`performance_timeseries_qualification_output:${outputId}`);
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

function queryWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function compileProgram(input: PerformanceTimeseriesProgramInput) {
  const deferred = input.deferred;
  if (!isDeferredPerformanceSummaryQualificationRequest(deferred))
    throw new Error("performance_timeseries_qualification_request_invalid");
  if (
    deferredPerformanceSummaryQualificationFromQuery(input.query) !== deferred
  )
    throw new Error("performance_timeseries_qualification_request_changed");
  if (
    deferred.configuration.mode !== "timeseries" ||
    input.query.mode !== "timeseries" ||
    input.query.interval !== deferred.configuration.interval
  )
    throw new Error("performance_timeseries_qualification_request_changed");
  const interval = deferred.configuration.interval;

  const qualification = buildPerformanceTimeseriesQualificationPlan({
    siteId: deferred.qualification.siteId,
    queryTime: deferred.qualification.requestTime,
    filters: deferred.qualification.filters,
    ...(deferred.qualification.performanceFilterMode === "allow-whole-filter"
      ? { filterMode: deferred.qualification.performanceFilterMode }
      : {}),
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
    interval,
    ...("eventCandidateReportProjection" in deferred.qualification &&
    deferred.qualification.eventCandidateReportProjection === "page-visits"
      ? { eventCandidateReportProjection: "page-visits" as const }
      : {}),
  });
  if (
    qualification.reportOutputIds.length !==
      PERFORMANCE_ALL_TRENDS_OUTPUT_IDS.length ||
    qualification.reportOutputIds.some(
      (outputId, index) =>
        outputId !== PERFORMANCE_ALL_TRENDS_OUTPUT_IDS[index],
    )
  )
    throw new Error(
      "performance_timeseries_qualification_plan_identity_invalid",
    );
  const reports = PERFORMANCE_ALL_TRENDS_OUTPUT_IDS.map((outputId) => {
    const output = exactOutput(qualification.plan.outputs, outputId);
    return {
      output,
      fields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
      rowType: "trend",
    };
  });
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    PERFORMANCE_TIMESERIES_QUALIFICATION_CONTROL_OUTPUT,
  );
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports,
    controlsOutput,
    reportFields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    controlFields: controlsOutput.fields.map(({ name }) => name),
    ordering: [
      { field: "metric", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
    ],
    errorPrefix: "performance_timeseries_qualification",
    fallbackTag: "analytics.performance_timeseries_qualification",
    signal: deferred.qualification.signal,
  });
  return { deferred, interval, compilation };
}

export function compilePerformanceTimeseriesQualificationProgram(
  input: PerformanceTimeseriesProgramInput,
): PerformanceTimeseriesQualificationCompilation {
  return compileProgram(input).compilation;
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredPerformanceSummaryQualification,
  interval: Interval,
  evidence: QualificationEnvelopeCompilationEvidence,
): PerformanceTimeseriesQualificationExecution {
  if (
    deferred.configuration.mode !== "timeseries" ||
    deferred.configuration.interval !== interval
  )
    throw new Error("performance_timeseries_qualification_request_changed");
  const expectedFields = [
    "rowKind",
    "outputId",
    ...PERFORMANCE_REPORT_OUTPUT_FIELDS,
    ...evidence.controlFields,
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (
    controlRows.length !== 1 ||
    !exactRowKeys(controlRows[0]!, expectedFields) ||
    controlRows[0]!.outputId !== evidence.controlOutputId
  )
    throw new Error("performance_timeseries_qualification_control_row_invalid");
  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    PERFORMANCE_REPORT_OUTPUT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error(
      "performance_timeseries_qualification_control_kind_mismatch",
    );
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `performance_timeseries_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("performance_timeseries_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback") return judgment;
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error(
      "performance_timeseries_qualification_envelope_kind_invalid",
    );

  const metricByOutputId = new Map<string, PerformanceMetricKey>(
    PERFORMANCE_METRICS.map(({ key }, index) => [
      PERFORMANCE_ALL_TRENDS_OUTPUT_IDS[index]!,
      key,
    ]),
  );
  const requestTime = deferred.qualification.requestTime;
  const window = queryWindow(requestTime);
  const buckets = buildTimeBuckets(window, interval);
  const seen = new Set<string>();
  for (const row of reportRows) {
    const metric = metricByOutputId.get(String(row.outputId));
    const bucket = row.bucket;
    if (
      !exactRowKeys(row, expectedFields) ||
      !metric ||
      row.rowType !== "trend" ||
      row.metric !== metric ||
      typeof bucket !== "number" ||
      !Number.isSafeInteger(bucket) ||
      bucket < 0 ||
      bucket >= buckets.length ||
      row.pathname !== null ||
      row.country !== null ||
      row.views !== null ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(
        "performance_timeseries_qualification_report_row_invalid",
      );
    const key = `${metric}:${bucket}`;
    if (seen.has(key))
      throw new Error(
        "performance_timeseries_qualification_report_duplicate_bucket",
      );
    seen.add(key);
    for (const descriptor of PERFORMANCE_METRICS) {
      const current = descriptor.key === metric;
      for (const suffix of [
        "Samples",
        "AvgValue",
        "P50",
        "P75",
        "P95",
      ] as const) {
        if (!current && row[`${descriptor.key}${suffix}`] !== null)
          throw new Error(
            "performance_timeseries_qualification_report_metric_fields_invalid",
          );
      }
    }
  }

  const trends = mapPerformanceTrendReportRows(reportRows, window, interval);
  return { kind: "executed", trends, evidence };
}

export async function executePerformanceTimeseriesQualificationProgram(
  input: PerformanceTimeseriesProgramInput & {
    readonly env: Env;
    readonly diagnostics?: D1ReadDiagnostics;
  },
): Promise<PerformanceTimeseriesQualificationExecution> {
  const { deferred, interval, compilation } = compileProgram(input);
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
  const execution = decodeRows(rows, deferred, interval, compilation.evidence);
  if (execution.kind === "fallback" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  return execution;
}
