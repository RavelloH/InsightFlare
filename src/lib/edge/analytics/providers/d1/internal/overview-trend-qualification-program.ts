import type { CompiledQuery } from "@/lib/db";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import {
  buildOverviewTrendQualificationPlan,
  type LegacyOverviewTrendQualificationConfiguration,
  type OverviewTrendQualificationConfiguration,
} from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import {
  type DeferredOverviewTrendQualification,
  isDeferredEventQualification,
  isDeferredOverviewTrendQualification,
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

const AGGREGATE_OUTPUT = "overview-aggregate";
const TREND_OUTPUT = "overview-trend";
const CONTROL_BASE_FIELDS = [
  "rawCount",
  "nullActivityIdCount",
  "siteIdentityMismatchCount",
  "entityKind",
  "invalidIdentityCount",
  "duplicateIdentityCount",
] as const;
const AGGREGATE_FIELDS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
const TREND_FIELDS = [
  "bucket",
  "views",
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
const ENVELOPE_REPORT_FIELDS = [
  "bucket",
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
const CALENDAR_GRANULARITIES = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;

type KnownOverviewTrendConfiguration =
  | { readonly kind: "aggregate" }
  | {
      readonly kind: "trend" | "overview-with-detail";
      readonly interval: (typeof CALENDAR_GRANULARITIES)[number];
    };

function isLegacyOverviewTrendConfiguration(
  value: OverviewTrendQualificationConfiguration,
): value is LegacyOverviewTrendQualificationConfiguration {
  return (
    value.kind === "aggregate" ||
    value.kind === "trend" ||
    value.kind === "overview-with-detail"
  );
}

function readKnownConfiguration(
  value: unknown,
): KnownOverviewTrendConfiguration | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      return undefined;
    const keys = Reflect.ownKeys(value);
    const readDataProperty = (key: "kind" | "interval") => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && descriptor.enumerable
        ? descriptor.value
        : undefined;
    };
    const kind = readDataProperty("kind");
    if (kind === "aggregate" && keys.length === 1 && keys[0] === "kind")
      return { kind };
    if (
      (kind === "trend" || kind === "overview-with-detail") &&
      keys.length === 2 &&
      keys.includes("kind") &&
      keys.includes("interval")
    ) {
      const interval = readDataProperty("interval");
      if (
        typeof interval === "string" &&
        CALENDAR_GRANULARITIES.includes(
          interval as (typeof CALENDAR_GRANULARITIES)[number],
        )
      )
        return {
          kind,
          interval: interval as (typeof CALENDAR_GRANULARITIES)[number],
        };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function matchesFrozenConfiguration(
  requested: unknown,
  frozen: LegacyOverviewTrendQualificationConfiguration,
): boolean {
  if (!Object.isFrozen(frozen)) return false;
  const requestedValue = readKnownConfiguration(requested);
  const frozenValue = readKnownConfiguration(frozen);
  return (
    requestedValue !== undefined &&
    frozenValue !== undefined &&
    requestedValue.kind === frozenValue.kind &&
    (requestedValue.kind === "aggregate" ||
      (frozenValue.kind !== "aggregate" &&
        requestedValue.interval === frozenValue.interval))
  );
}

export interface OverviewTrendQualificationCompilationEvidence {
  readonly statementTag: QualificationEnvelopeCompilationEvidence["statementTag"];
  readonly sql: QualificationEnvelopeCompilationEvidence["sql"];
  readonly bindings: QualificationEnvelopeCompilationEvidence["bindings"];
  readonly sqlBytes: QualificationEnvelopeCompilationEvidence["sqlBytes"];
  readonly bindingCount: QualificationEnvelopeCompilationEvidence["bindingCount"];
  readonly groupWidth: QualificationEnvelopeCompilationEvidence["groupWidth"];
  readonly sharedRelationCount: QualificationEnvelopeCompilationEvidence["sharedRelationCount"];
  readonly rootKind: QualificationEnvelopeCompilationEvidence["rootKind"];
  readonly physicalPlanShape?: QualificationEnvelopeCompilationEvidence["physicalPlanShape"];
  readonly logicalPlan: AnalyticsQualificationPlan["plan"];
  readonly configuration: LegacyOverviewTrendQualificationConfiguration;
  readonly reportSourceRelations: QualificationEnvelopeCompilationEvidence["reportSourceRelations"];
  readonly controlOutputId: QualificationEnvelopeCompilationEvidence["controlOutputId"];
  readonly controlFields: QualificationEnvelopeCompilationEvidence["controlFields"];
  readonly compatibilityFields: QualificationEnvelopeCompilationEvidence["compatibilityFields"];
  readonly outputDescriptors: QualificationEnvelopeCompilationEvidence["outputDescriptors"];
}

export type OverviewTrendQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: OverviewTrendQualificationCompilationEvidence;
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
    throw new Error(`overview_trend_qualification_output:${outputId}`);
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

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`overview_trend_qualification_value_invalid:${field}`);
  return value;
}

function nonnegativeFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`overview_trend_qualification_value_invalid:${field}`);
  return value;
}

function reportFields(outputId: string): readonly string[] {
  if (outputId === AGGREGATE_OUTPUT) return AGGREGATE_FIELDS;
  if (outputId === TREND_OUTPUT) return TREND_FIELDS;
  throw new Error(`overview_trend_qualification_report_output:${outputId}`);
}

function controlFieldsFor(qualification: AnalyticsQualificationPlan) {
  return [
    ...CONTROL_BASE_FIELDS,
    ...qualification.numericCompatibilityFields.map(
      ({ invalidCountOutput }) => invalidCountOutput,
    ),
  ];
}

function verifyPlan(
  qualification: AnalyticsQualificationPlan,
  deferred: DeferredOverviewTrendQualification,
  configuration: LegacyOverviewTrendQualificationConfiguration,
): {
  readonly reportOutputs: readonly LogicalOutput[];
  readonly controlsOutput: LogicalOutput;
  readonly controlFields: readonly string[];
} {
  const expectedReportOutputIds =
    configuration.kind === "aggregate"
      ? [AGGREGATE_OUTPUT]
      : configuration.kind === "trend"
        ? [TREND_OUTPUT]
        : [AGGREGATE_OUTPUT, TREND_OUTPUT];
  if (
    qualification.scope !== deferred.qualification.countInput.scope ||
    (qualification.scope !== "session" && qualification.scope !== "visitor") ||
    qualification.controlOutputId !==
      OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT ||
    qualification.reportOutputIds.length !== expectedReportOutputIds.length ||
    qualification.reportOutputIds.some(
      (outputId, index) => outputId !== expectedReportOutputIds[index],
    ) ||
    qualification.reportSourceRelations.length !== 2 ||
    qualification.reportSourceRelations[0]?.entity !== "page" ||
    qualification.reportSourceRelations[1]?.entity !== "event"
  )
    throw new Error("overview_trend_qualification_plan_identity_invalid");

  const reportOutputs = expectedReportOutputIds.map((outputId) => {
    const output = exactOutput(qualification.plan.outputs, outputId);
    const fields = reportFields(outputId);
    if (
      output.fields.length !== fields.length ||
      output.fields.some((field, index) => field.name !== fields[index])
    )
      throw new Error(`overview_trend_qualification_schema:${outputId}`);
    return output;
  });
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    qualification.controlOutputId,
  );
  const controlFields = controlsOutput.fields.map(({ name }) => name);
  const expectedControlFields = controlFieldsFor(qualification);
  if (
    new Set(controlFields).size !== controlFields.length ||
    controlFields.length !== expectedControlFields.length ||
    expectedControlFields.some((name) => !controlFields.includes(name))
  )
    throw new Error("overview_trend_qualification_controls_invalid");
  return { reportOutputs, controlsOutput, controlFields };
}

function compileProgram(input: {
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: LegacyOverviewTrendQualificationConfiguration;
}):
  | {
      readonly kind: "compiled";
      readonly query: CompiledQuery<Record<string, unknown>>;
      readonly evidence: OverviewTrendQualificationCompilationEvidence;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    } {
  const { deferred } = input;
  if (
    !isDeferredOverviewTrendQualification(deferred) ||
    !Object.isFrozen(deferred) ||
    !isLegacyOverviewTrendConfiguration(deferred.configuration) ||
    !matchesFrozenConfiguration(input.configuration, deferred.configuration) ||
    !isDeferredEventQualification(deferred.qualification) ||
    deferred.qualification.operation !== deferred.operation ||
    (deferred.operation !== "overview" && deferred.operation !== "trend") ||
    (deferred.operation === "overview" &&
      deferred.configuration.kind === "trend") ||
    (deferred.operation === "trend" && deferred.configuration.kind !== "trend")
  )
    throw new Error("overview_trend_qualification_request_untrusted");
  const configuration: LegacyOverviewTrendQualificationConfiguration =
    deferred.configuration;
  const qualification = buildOverviewTrendQualificationPlan({
    semanticOperation: deferred.operation,
    siteId: deferred.qualification.siteId,
    queryTime: deferred.qualification.requestTime!,
    filters: deferred.qualification.filters,
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
    configuration,
  });
  const verified = verifyPlan(qualification, deferred, configuration);
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports: verified.reportOutputs.map((output) => ({
      output,
      fields: reportFields(output.id),
      rowType: output.id === AGGREGATE_OUTPUT ? "aggregate" : "trend",
    })),
    controlsOutput: verified.controlsOutput,
    reportFields: ENVELOPE_REPORT_FIELDS,
    controlFields: verified.controlFields,
    errorPrefix: "overview_trend_qualification",
    fallbackTag: "analytics.overview_trend_qualification",
    signal: deferred.qualification.signal,
  });
  if (compilation.kind === "unavailable") return compilation;
  return {
    ...compilation,
    evidence: Object.freeze({
      ...compilation.evidence,
      configuration,
    }),
  };
}

/** Compile a frozen request before execution so adapters can retain admission evidence. */
export function compileOverviewTrendQualificationProgram(input: {
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: LegacyOverviewTrendQualificationConfiguration;
}) {
  return compileProgram(input);
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredOverviewTrendQualification,
  configuration: LegacyOverviewTrendQualificationConfiguration,
  evidence: OverviewTrendQualificationCompilationEvidence,
): OverviewTrendQualificationExecution {
  const controlFields = [
    "rowKind",
    "outputId",
    ...ENVELOPE_REPORT_FIELDS,
    ...evidence.controlFields,
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  if (
    controlRows.length !== 1 ||
    !exactRowKeys(controlRows[0]!, controlFields) ||
    controlRows[0]!.outputId !== evidence.controlOutputId
  )
    throw new Error("overview_trend_qualification_control_row_invalid");
  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    ENVELOPE_REPORT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error("overview_trend_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `overview_trend_qualification_control_invalid:${field}`,
  });
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error("overview_trend_qualification_envelope_kind_invalid");
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("overview_trend_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const expectedOutputs = new Set(
    configuration.kind === "aggregate"
      ? [AGGREGATE_OUTPUT]
      : configuration.kind === "trend"
        ? [TREND_OUTPUT]
        : [AGGREGATE_OUTPUT, TREND_OUTPUT],
  );
  const aggregateRows: Record<string, unknown>[] = [];
  const trendRows: Record<string, unknown>[] = [];
  let priorBucket = -1;
  for (const row of reportRows) {
    if (
      !exactRowKeys(row, controlFields) ||
      typeof row.outputId !== "string" ||
      !expectedOutputs.has(row.outputId) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error("overview_trend_qualification_report_row_invalid");
    if (row.outputId === AGGREGATE_OUTPUT) {
      if (
        row.bucket !== null ||
        !Number.isSafeInteger(row.views) ||
        !Number.isSafeInteger(row.sessions) ||
        !Number.isSafeInteger(row.visitors) ||
        !Number.isSafeInteger(row.bounces) ||
        !Number.isSafeInteger(row.durationViews)
      )
        throw new Error("overview_trend_qualification_aggregate_invalid");
      nonnegativeInteger(row.views, "views");
      nonnegativeInteger(row.sessions, "sessions");
      nonnegativeInteger(row.visitors, "visitors");
      nonnegativeInteger(row.bounces, "bounces");
      nonnegativeInteger(row.durationViews, "durationViews");
      nonnegativeFiniteNumber(row.totalDuration, "totalDuration");
      aggregateRows.push(row);
      continue;
    }
    if (row.outputId !== TREND_OUTPUT)
      throw new Error("overview_trend_qualification_report_output_invalid");
    const bucket = nonnegativeInteger(row.bucket, "bucket");
    if (bucket <= priorBucket)
      throw new Error("overview_trend_qualification_bucket_order_invalid");
    priorBucket = bucket;
    nonnegativeInteger(row.views, "views");
    nonnegativeInteger(row.visitors, "visitors");
    nonnegativeInteger(row.sessions, "sessions");
    nonnegativeInteger(row.bounces, "bounces");
    nonnegativeInteger(row.durationViews, "durationViews");
    nonnegativeFiniteNumber(row.totalDuration, "totalDuration");
    trendRows.push(row);
  }
  if (
    aggregateRows.length !== (expectedOutputs.has(AGGREGATE_OUTPUT) ? 1 : 0) ||
    new Set(trendRows.map((row) => row.bucket)).size !== trendRows.length
  )
    throw new Error("overview_trend_qualification_report_cardinality_invalid");
  return {
    kind: "executed",
    rows: Object.freeze([...aggregateRows, ...trendRows]),
    evidence,
  };
}

export async function executeOverviewTrendQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: LegacyOverviewTrendQualificationConfiguration;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<OverviewTrendQualificationExecution> {
  const compilation = compileProgram({
    deferred: input.deferred,
    configuration: input.configuration,
  });
  if (compilation.kind === "unavailable") return compilation;
  const rows = await executeQualificationQuery(
    input.deferred.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query,
        input.diagnostics,
      ),
  );
  return decodeRows(
    rows,
    input.deferred,
    compilation.evidence.configuration,
    compilation.evidence,
  );
}
