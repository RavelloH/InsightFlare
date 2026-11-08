import type { QueryInput } from "@/lib/edge/analytics/contract";
import type { SitePerformanceBreakdownDimension } from "@/lib/edge/analytics/contract/performance-dimensions";
import type { PerformanceMetricKey } from "@/lib/edge/analytics/contract/types";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPerformanceBreakdownDashboardQualificationPlan,
  PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT,
  type PerformanceBreakdownDashboardQualificationMode,
} from "@/lib/edge/analytics/engine/performance-breakdown-dashboard-qualification-plan";
import {
  PERFORMANCE_COUNTRIES_OUTPUT_IDS,
  PERFORMANCE_DASHBOARD_OUTPUT_IDS,
  PERFORMANCE_METRICS,
  PERFORMANCE_REPORT_OUTPUT_FIELDS,
  PERFORMANCE_ROUTES_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  type DeferredPerformanceSummaryQualification,
  deferredPerformanceSummaryQualificationFromQuery,
  isDeferredPerformanceSummaryQualificationRequest,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type {
  PerformanceCountryRow,
  PerformanceDashboardResult,
  PerformanceRouteRow,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";
import { buildTimeBuckets } from "./core-time";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  mapPerformanceCountryReportRows,
  mapPerformanceDashboardReportRows,
  mapPerformanceRouteReportRows,
} from "./performance";
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

type DeferredPerformanceQuery = QueryInput & Record<string, unknown>;
const SQLITE_UTF8_ENCODER = new TextEncoder();

type ModeResult =
  | {
      readonly mode: "breakdown";
      readonly dimension: SitePerformanceBreakdownDimension;
      readonly metric: PerformanceMetricKey;
      readonly rows: readonly (PerformanceRouteRow | PerformanceCountryRow)[];
    }
  | { readonly mode: "dashboard"; readonly value: PerformanceDashboardResult };

export type PerformanceBreakdownDashboardQualificationExecution =
  | {
      readonly kind: "executed";
      readonly value: ModeResult;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export interface PerformanceBreakdownDashboardProgramInput {
  readonly query: DeferredPerformanceQuery;
  readonly deferred: DeferredPerformanceSummaryQualification;
}

function exactKeys(row: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function exactOutput(outputs: readonly LogicalOutput[], outputId: string) {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(
      `performance_breakdown_dashboard_qualification_output:${outputId}`,
    );
  return matches[0]!;
}

function queryWindow(
  deferred: DeferredPerformanceSummaryQualification,
): QueryWindow {
  const time = deferred.qualification.requestTime;
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function modeFromRequest(
  deferred: DeferredPerformanceSummaryQualification,
): PerformanceBreakdownDashboardQualificationMode {
  const configuration = deferred.configuration;
  if (configuration.mode === "breakdown")
    return {
      mode: "breakdown",
      dimension: configuration.dimension,
      metric: configuration.metric,
      limit: configuration.limitValue ?? 20,
    };
  if (configuration.mode === "dashboard")
    return {
      mode: "dashboard",
      interval: configuration.interval,
      routeLimit: configuration.routeLimitValue ?? 18,
    };
  throw new Error("performance_breakdown_dashboard_qualification_mode_invalid");
}

function compileProgram(input: PerformanceBreakdownDashboardProgramInput) {
  const deferred = input.deferred;
  if (!isDeferredPerformanceSummaryQualificationRequest(deferred))
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_invalid",
    );
  if (
    deferredPerformanceSummaryQualificationFromQuery(input.query) !== deferred
  )
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_changed",
    );
  const mode = modeFromRequest(deferred);
  if (input.query.mode !== mode.mode)
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_changed",
    );
  if (
    mode.mode === "breakdown" &&
    (input.query.dimension !== mode.dimension ||
      input.query.metric !== mode.metric)
  )
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_changed",
    );
  if (mode.mode === "dashboard" && input.query.interval !== mode.interval)
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_changed",
    );

  const qualification = buildPerformanceBreakdownDashboardQualificationPlan({
    siteId: deferred.qualification.siteId,
    queryTime: deferred.qualification.requestTime,
    filters: deferred.qualification.filters,
    ...(deferred.qualification.performanceFilterMode === "allow-whole-filter"
      ? { filterMode: deferred.qualification.performanceFilterMode }
      : {}),
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
    mode,
    ...("eventCandidateReportProjection" in deferred.qualification &&
    deferred.qualification.eventCandidateReportProjection === "page-visits"
      ? { eventCandidateReportProjection: "page-visits" as const }
      : {}),
  });
  const outputIds = qualification.reportOutputIds;
  const expectedOutputIds =
    mode.mode === "dashboard"
      ? PERFORMANCE_DASHBOARD_OUTPUT_IDS
      : mode.dimension === "page.path"
        ? PERFORMANCE_ROUTES_OUTPUT_IDS
        : PERFORMANCE_COUNTRIES_OUTPUT_IDS;
  if (
    outputIds.length !== expectedOutputIds.length ||
    outputIds.some((outputId, index) => outputId !== expectedOutputIds[index])
  )
    throw new Error(
      "performance_breakdown_dashboard_qualification_plan_identity_invalid",
    );
  const reports = outputIds.map((outputId) => {
    const output = exactOutput(qualification.plan.outputs, outputId);
    const rowType = /^performance-(summary|trend|route|country)-/u.exec(
      outputId,
    )?.[1];
    if (!rowType)
      throw new Error(
        `performance_breakdown_dashboard_qualification_row_type:${outputId}`,
      );
    return { output, fields: PERFORMANCE_REPORT_OUTPUT_FIELDS, rowType };
  });
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT,
  );
  const ordering =
    mode.mode === "dashboard"
      ? [
          {
            field: "rowType",
            direction: "asc" as const,
            nulls: "first" as const,
          },
          {
            field: "metric",
            direction: "asc" as const,
            nulls: "first" as const,
          },
          {
            field: "bucket",
            direction: "asc" as const,
            nulls: "first" as const,
          },
          {
            field: "pathname",
            direction: "asc" as const,
            nulls: "first" as const,
          },
          {
            field: "country",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ]
      : [
          {
            field: "views",
            direction: "desc" as const,
            nulls: "last" as const,
          },
          {
            field: mode.dimension === "page.path" ? "pathname" : "country",
            direction: "asc" as const,
            nulls: "first" as const,
          },
          {
            field: "metric",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ];
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports,
    controlsOutput,
    reportFields: PERFORMANCE_REPORT_OUTPUT_FIELDS,
    controlFields: controlsOutput.fields.map(({ name }) => name),
    ordering,
    errorPrefix: "performance_breakdown_dashboard_qualification",
    fallbackTag: `analytics.performance_${mode.mode}_qualification`,
    signal: deferred.qualification.signal,
  });
  return { deferred, mode, compilation };
}

export function compilePerformanceBreakdownDashboardQualificationProgram(
  input: PerformanceBreakdownDashboardProgramInput,
): QualificationEnvelopeCompilation {
  return compileProgram(input).compilation;
}

function compareNullable(
  left: unknown,
  right: unknown,
  direction: "asc" | "desc",
  nulls: "first" | "last",
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull)
    return leftNull === rightNull
      ? 0
      : leftNull === (nulls === "first")
        ? -1
        : 1;
  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : compareSqliteBinaryText(String(left), String(right));
  return direction === "asc" ? order : -order;
}

function compareSqliteBinaryText(left: string, right: string): number {
  const leftBytes = SQLITE_UTF8_ENCODER.encode(left);
  const rightBytes = SQLITE_UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function sortedRows(
  rows: Record<string, unknown>[],
  mode: PerformanceBreakdownDashboardQualificationMode,
) {
  return [...rows].sort((left, right) => {
    const keys =
      mode.mode === "dashboard"
        ? ([
            ["rowType", "asc", "first"],
            ["metric", "asc", "first"],
            ["bucket", "asc", "first"],
            ["pathname", "asc", "first"],
            ["country", "asc", "first"],
          ] as const)
        : ([
            ["views", "desc", "last"],
            [
              mode.dimension === "page.path" ? "pathname" : "country",
              "asc",
              "first",
            ],
            ["metric", "asc", "first"],
          ] as const);
    for (const [field, direction, nulls] of keys) {
      const difference = compareNullable(
        left[field],
        right[field],
        direction,
        nulls,
      );
      if (difference) return difference;
    }
    return 0;
  });
}

function validMetricValues(row: Record<string, unknown>, metric: string) {
  for (const descriptor of PERFORMANCE_METRICS) {
    const current = descriptor.key === metric;
    for (const suffix of [
      "Samples",
      "AvgValue",
      "P50",
      "P75",
      "P95",
    ] as const) {
      const value = row[`${descriptor.key}${suffix}`];
      if (!current && value !== null) return false;
      if (
        current &&
        suffix === "Samples" &&
        value !== null &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      )
        return false;
      if (
        current &&
        suffix !== "Samples" &&
        value !== null &&
        typeof value !== "number"
      )
        return false;
    }
  }
  return true;
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredPerformanceSummaryQualification,
  mode: PerformanceBreakdownDashboardQualificationMode,
  evidence: QualificationEnvelopeCompilationEvidence,
): PerformanceBreakdownDashboardQualificationExecution {
  if (deferred.configuration.mode !== mode.mode)
    throw new Error(
      "performance_breakdown_dashboard_qualification_request_changed",
    );
  const expectedFields = [
    "rowKind",
    "outputId",
    ...PERFORMANCE_REPORT_OUTPUT_FIELDS,
    ...evidence.controlFields,
  ];
  const expectedById = new Map(
    evidence.outputDescriptors.map(({ outputId, rowType }) => [
      outputId,
      rowType,
    ]),
  );
  const controlRows = rows.filter((row) => row.rowKind === "control");
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (
    controlRows.length !== 1 ||
    !exactKeys(controlRows[0]!, expectedFields) ||
    controlRows[0]!.outputId !== evidence.controlOutputId ||
    rows.length !== controlRows.length + reportRows.length
  )
    throw new Error(
      "performance_breakdown_dashboard_qualification_control_row_invalid",
    );
  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    PERFORMANCE_REPORT_OUTPUT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error(
      "performance_breakdown_dashboard_qualification_control_kind_mismatch",
    );
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `performance_breakdown_dashboard_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("performance_breakdown_dashboard_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback") return judgment;

  const window = queryWindow(deferred);
  const bucketCount =
    mode.mode === "dashboard"
      ? buildTimeBuckets(window, mode.interval).length
      : 0;
  const seen = new Set<string>();
  const normalizedRows = reportRows.map((row) => {
    const outputId = String(row.outputId ?? "");
    const rowType = expectedById.get(outputId);
    const metric = PERFORMANCE_METRICS.find(({ key }) =>
      outputId.endsWith(`-${key}`),
    )?.key;
    if (
      !exactKeys(row, expectedFields) ||
      !rowType ||
      !metric ||
      row.rowType !== rowType ||
      row.metric !== metric ||
      evidence.controlFields.some((field) => row[field] !== null) ||
      !validMetricValues(row, metric)
    )
      throw new Error(
        "performance_breakdown_dashboard_qualification_report_row_invalid",
      );
    if (rowType === "summary") {
      if (
        ["bucket", "pathname", "country", "views"].some(
          (field) => row[field] !== null,
        )
      )
        throw new Error(
          "performance_breakdown_dashboard_qualification_report_null_shape_invalid",
        );
    } else if (rowType === "trend") {
      const bucket = row.bucket;
      if (
        typeof bucket !== "number" ||
        !Number.isSafeInteger(bucket) ||
        bucket < 0 ||
        bucket >= bucketCount ||
        row.pathname !== null ||
        row.country !== null ||
        row.views !== null
      )
        throw new Error(
          "performance_breakdown_dashboard_qualification_report_null_shape_invalid",
        );
    } else if (rowType === "route") {
      if (
        typeof row.pathname !== "string" ||
        row.bucket !== null ||
        row.country !== null ||
        typeof row.views !== "number"
      )
        throw new Error(
          "performance_breakdown_dashboard_qualification_report_null_shape_invalid",
        );
    } else if (
      typeof row.country !== "string" ||
      row.country.length === 0 ||
      row.bucket !== null ||
      row.pathname !== null ||
      typeof row.views !== "number"
    )
      throw new Error(
        "performance_breakdown_dashboard_qualification_report_null_shape_invalid",
      );
    const groupKey =
      rowType === "summary"
        ? "summary"
        : rowType === "trend"
          ? String(row.bucket)
          : rowType === "route"
            ? String(row.pathname)
            : String(row.country);
    const unique = `${outputId}:${groupKey}`;
    if (seen.has(unique))
      throw new Error(
        "performance_breakdown_dashboard_qualification_report_duplicate",
      );
    seen.add(unique);
    return row;
  });
  const orderedRows = sortedRows(normalizedRows, mode);
  if (mode.mode === "dashboard")
    return {
      kind: "executed",
      value: {
        mode: "dashboard",
        value: mapPerformanceDashboardReportRows(
          orderedRows,
          window,
          mode.interval,
        ),
      },
      evidence,
    };
  const mapped =
    mode.dimension === "page.path"
      ? mapPerformanceRouteReportRows(orderedRows)
      : mapPerformanceCountryReportRows(orderedRows);
  return {
    kind: "executed",
    value: {
      mode: "breakdown",
      dimension: mode.dimension,
      metric: mode.metric,
      rows: mapped,
    },
    evidence,
  };
}

export async function executePerformanceBreakdownDashboardQualificationProgram(
  input: PerformanceBreakdownDashboardProgramInput & {
    readonly env: Env;
    readonly diagnostics?: D1ReadDiagnostics;
  },
): Promise<PerformanceBreakdownDashboardQualificationExecution> {
  const { deferred, mode, compilation } = compileProgram(input);
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
  const execution = decodeRows(rows, deferred, mode, compilation.evidence);
  if (execution.kind === "fallback" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  return execution;
}
