import type { CompiledQuery } from "@/lib/db";
import type { CanonicalQuery } from "@/lib/edge/analytics/contract";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type {
  LogicalOutput,
  LogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildOverviewPreviousQualificationPlan,
  type OverviewPreviousConfiguration,
  type OverviewPreviousQualificationPlan,
} from "@/lib/edge/analytics/engine/overview-previous-qualification-plan";
import {
  OVERVIEW_CURRENT_COHORT_OUTPUT,
  OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import type { AnalysisResultQualificationBinding } from "@/lib/edge/analytics/providers/d1/internal/lowering/comparison-page-admission";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import type { Env } from "@/lib/edge/types";

import {
  type DeferredOverviewTrendQualification,
  deferredOverviewTrendQualificationFromQuery,
  isDeferredEventQualification,
  isDeferredOverviewTrendQualification,
} from "./advanced-filter-execution";
import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  isInvalidOverviewSnapshot,
  serializeOwnDataSnapshot,
  snapshotOwnDataValue,
} from "./overview-previous-time";
import { qualificationCompatibilityFieldsFromNumeric } from "./qualification-compatibility";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilationEvidence,
  type QualificationEnvelopeQualification,
} from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

const CURRENT_AGGREGATE_OUTPUT = "overview-current-aggregate";
const PREVIOUS_AGGREGATE_OUTPUT = "overview-previous-aggregate";
const TREND_OUTPUT = "overview-trend";
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
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

export interface OverviewPreviousCompilationEvidence extends QualificationEnvelopeCompilationEvidence {
  readonly configuration: OverviewPreviousConfiguration;
  readonly currentCohortOutputId: typeof OVERVIEW_CURRENT_COHORT_OUTPUT;
}

export type OverviewPreviousQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: OverviewPreviousCompilationEvidence;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function exactOutput(plan: LogicalPlan, id: string): LogicalOutput {
  const matches = plan.outputs.filter((output) => output.id === id);
  if (matches.length !== 1)
    throw new Error(`overview_previous_qualification_output:${id}`);
  return matches[0]!;
}

function exactFields(output: LogicalOutput, expected: readonly string[]): void {
  if (
    output.fields.length !== expected.length ||
    output.fields.some((field, index) => field.name !== expected[index])
  )
    throw new Error(`overview_previous_qualification_schema:${output.id}`);
}

function deeplyFrozenOwnData(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (!Object.isFrozen(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return false;
      if (!deeplyFrozenOwnData(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sameConfiguration(
  requested: unknown,
  trusted: OverviewPreviousConfiguration,
): boolean {
  const requestedSnapshot = snapshotOwnDataValue(requested);
  const trustedSnapshot = snapshotOwnDataValue(trusted);
  if (
    isInvalidOverviewSnapshot(requestedSnapshot) ||
    isInvalidOverviewSnapshot(trustedSnapshot)
  )
    return false;
  const requestedJson = serializeOwnDataSnapshot(requestedSnapshot);
  return (
    requestedJson !== undefined &&
    requestedJson === serializeOwnDataSnapshot(trustedSnapshot)
  );
}

function isPreviousConfiguration(
  value: unknown,
): value is OverviewPreviousConfiguration {
  if (typeof value !== "object" || value === null) return false;
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  return (
    !!kind &&
    "value" in kind &&
    (kind.value === "overview-with-previous" ||
      kind.value === "overview-with-previous-and-detail")
  );
}

function verifyDeferredRequest(input: {
  readonly query: CanonicalQuery<"overview">;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: OverviewPreviousConfiguration;
}): OverviewPreviousConfiguration {
  if (
    !isDeferredOverviewTrendQualification(input.deferred) ||
    !Object.isFrozen(input.deferred) ||
    !deeplyFrozenOwnData(input.deferred.configuration) ||
    !isDeferredEventQualification(input.deferred.qualification) ||
    input.deferred.operation !== "overview" ||
    input.deferred.qualification.operation !== "overview" ||
    !input.deferred.qualification.requestTime ||
    !isPreviousConfiguration(input.deferred.configuration) ||
    !deeplyFrozenOwnData(input.configuration) ||
    !sameConfiguration(input.configuration, input.deferred.configuration) ||
    deferredOverviewTrendQualificationFromQuery(input.query, "overview") !==
      input.deferred
  )
    throw new Error("overview_previous_qualification_request_untrusted");
  return input.deferred.configuration;
}

function validatePlan(
  qualification: OverviewPreviousQualificationPlan,
  deferred: DeferredOverviewTrendQualification,
  configuration: OverviewPreviousConfiguration,
) {
  const child = qualification.childQualification;
  const hasDetail = configuration.kind === "overview-with-previous-and-detail";
  const expectedChildOutputs = [
    "overview-aggregate",
    ...(hasDetail ? [TREND_OUTPUT] : []),
    OVERVIEW_CURRENT_COHORT_OUTPUT,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  ];
  if (
    child.scope !== deferred.qualification.countInput.scope ||
    (child.scope !== "session" && child.scope !== "visitor") ||
    child.controlOutputId !== OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT ||
    child.reportOutputIds.length !== expectedChildOutputs.length - 1 ||
    child.reportOutputIds.some(
      (outputId, index) => outputId !== expectedChildOutputs[index],
    ) ||
    child.reportSourceRelations.length !== 2 ||
    child.reportSourceRelations[0]?.entity !== "page" ||
    child.reportSourceRelations[1]?.entity !== "event"
  )
    throw new Error("overview_previous_qualification_child_identity_invalid");
  exactFields(exactOutput(child.plan, "overview-aggregate"), AGGREGATE_FIELDS);
  if (hasDetail)
    exactFields(exactOutput(child.plan, TREND_OUTPUT), TREND_FIELDS);
  exactFields(exactOutput(child.plan, OVERVIEW_CURRENT_COHORT_OUTPUT), [
    "siteId",
    "entityId",
  ]);
  const childControls = exactOutput(
    child.plan,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  );
  const expectedControlFields = [
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "entityKind",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    ...qualificationCompatibilityFieldsFromNumeric(
      child.numericCompatibilityFields,
    ).map(({ outputName }) => outputName),
  ];
  if (
    new Set(childControls.fields.map(({ name }) => name)).size !==
      expectedControlFields.length ||
    expectedControlFields.some(
      (name) => !childControls.fields.some((field) => field.name === name),
    )
  )
    throw new Error("overview_previous_qualification_controls_invalid");

  const expectedReports = [
    CURRENT_AGGREGATE_OUTPUT,
    PREVIOUS_AGGREGATE_OUTPUT,
    ...(hasDetail ? [TREND_OUTPUT] : []),
  ];
  if (
    qualification.controlOutputId !==
      OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT ||
    qualification.reportOutputIds.length !== expectedReports.length ||
    qualification.reportOutputIds.some(
      (outputId, index) => outputId !== expectedReports[index],
    ) ||
    qualification.reportSourceRelations.length !== 2 ||
    qualification.reportSourceRelations[0]?.entity !== "page" ||
    qualification.reportSourceRelations[1]?.entity !== "event"
  )
    throw new Error("overview_previous_qualification_parent_identity_invalid");
  exactFields(
    exactOutput(qualification.plan, CURRENT_AGGREGATE_OUTPUT),
    AGGREGATE_FIELDS,
  );
  exactFields(
    exactOutput(qualification.plan, PREVIOUS_AGGREGATE_OUTPUT),
    AGGREGATE_FIELDS,
  );
  if (hasDetail)
    exactFields(exactOutput(qualification.plan, TREND_OUTPUT), TREND_FIELDS);
  exactFields(
    exactOutput(
      qualification.plan,
      OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    ),
    expectedControlFields,
  );
  return { childControls, expectedReports, expectedControlFields };
}

function childBinding(input: {
  readonly qualification: OverviewPreviousQualificationPlan;
  readonly childPlan: LogicalPlan;
}): AnalysisResultQualificationBinding {
  const childQualification = input.qualification.childQualification;
  const childControls = exactOutput(
    input.childPlan,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  );
  const reportOutputs = childQualification.reportOutputIds.map((outputId) =>
    exactOutput(input.childPlan, outputId),
  );
  const policy: AnalyticsQualificationAdmissionPolicy = {
    primaryReportSourceRelationId:
      childQualification.primaryReportSourceRelationId,
    reportSourceRelations: childQualification.reportSourceRelations,
    reportRelationIds: reportOutputs.map(({ relation }) => relation),
    controlsRelationId: childControls.relation,
    controlSlots: childControls.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: childQualification.scope,
    maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
    numericCompatibilityControlNames:
      childQualification.numericCompatibilityFields.map(
        ({ invalidCountOutput }) => invalidCountOutput,
      ),
  };
  return {
    childPlan: input.childPlan,
    reportOutputIds: childQualification.reportOutputIds,
    controlsOutputId: OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    policy,
  };
}

function importedChildSnapshot(
  plan: LogicalPlan,
  allowedOutputIds: ReadonlySet<string>,
): LogicalPlan {
  const children = plan.nodes.flatMap((node) =>
    node.kind === "analysis-result" && allowedOutputIds.has(node.outputId)
      ? [node.childPlan]
      : [],
  );
  const unique = [...new Set(children)];
  if (
    unique.length !== 1 ||
    plan.nodes.some(
      (node) =>
        node.kind === "analysis-result" && !allowedOutputIds.has(node.outputId),
    )
  )
    throw new Error("overview_previous_qualification_child_snapshot_invalid");
  return unique[0]!;
}

function compileProgram(input: {
  readonly query: CanonicalQuery<"overview">;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: OverviewPreviousConfiguration;
}) {
  const configuration = verifyDeferredRequest(input);
  let qualification: OverviewPreviousQualificationPlan;
  try {
    qualification = buildOverviewPreviousQualificationPlan({
      siteId: input.deferred.qualification.siteId,
      queryTime: input.deferred.qualification.requestTime,
      filters: input.deferred.qualification.filters,
      scopePlan: input.deferred.qualification.metadata.plan,
      count: input.deferred.qualification.countInput,
      configuration,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "overview_previous_native_filter_split_unsupported" ||
        error.message === "overview_previous_native_scope_plan_missing")
    )
      return {
        kind: "unavailable" as const,
        fallbackReason: { kind: "compiler-unavailable" as const },
      };
    throw error;
  }
  const verified = validatePlan(qualification, input.deferred, configuration);
  const reportOutputs = verified.expectedReports.map((outputId) =>
    exactOutput(qualification.plan, outputId),
  );
  const controlsOutput = exactOutput(
    qualification.plan,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  );
  const childOutputs = new Set([
    ...qualification.childQualification.reportOutputIds,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  ]);
  const childPlan = importedChildSnapshot(qualification.plan, childOutputs);
  const binding = childBinding({ qualification, childPlan });
  const envelopeQualification: QualificationEnvelopeQualification = {
    plan: qualification.plan,
    primaryReportSourceRelationId: qualification.primaryReportSourceRelationId,
    controlsRelationId: controlsOutput.relation,
    controlOutputId: qualification.controlOutputId,
    numericCompatibilityFields:
      qualification.childQualification.numericCompatibilityFields,
    scope: qualification.childQualification.scope,
    reportSourceRelations: qualification.reportSourceRelations,
  };
  const compilation = compileQualificationProgramEnvelope({
    qualification: envelopeQualification,
    siteId: input.deferred.qualification.siteId,
    reports: reportOutputs.map((output) => ({
      output,
      fields: output.id === TREND_OUTPUT ? TREND_FIELDS : AGGREGATE_FIELDS,
      rowType: output.id === TREND_OUTPUT ? "trend" : "aggregate",
    })),
    controlsOutput,
    reportFields: ENVELOPE_REPORT_FIELDS,
    controlFields: verified.expectedControlFields,
    errorPrefix: "overview_previous_qualification",
    fallbackTag: "analytics.overview_previous_qualification",
    signal: input.deferred.qualification.signal,
    analysisResultQualificationBindings: [binding],
    importedGroupedSummaryReference: Object.freeze({
      kind: "imported-child",
      childPlan,
      relationId: qualification.childQualification.groupedSummaryRelationId,
    }),
  });
  if (compilation.kind === "unavailable") return compilation;
  return {
    ...compilation,
    evidence: Object.freeze({
      ...compilation.evidence,
      configuration,
      currentCohortOutputId: OVERVIEW_CURRENT_COHORT_OUTPUT,
    }),
  };
}

export function compileOverviewPreviousQualificationProgram(input: {
  readonly query: CanonicalQuery<"overview">;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: OverviewPreviousConfiguration;
}) {
  return compileProgram(input);
}

function exactRowKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(row).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`overview_previous_qualification_value_invalid:${field}`);
  return value;
}

function overviewMapperNumber(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number")
    throw new Error(`overview_previous_qualification_value_invalid:${field}`);
  return value;
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredOverviewTrendQualification,
  evidence: OverviewPreviousCompilationEvidence,
): OverviewPreviousQualificationExecution {
  const expectedKeys = [
    "rowKind",
    "outputId",
    ...ENVELOPE_REPORT_FIELDS,
    ...evidence.controlFields,
  ];
  const controls = rows.filter((row) => row.rowKind === "control");
  const reports = rows.filter((row) => row.rowKind === "report");
  if (
    rows.length !== controls.length + reports.length ||
    controls.length !== 1 ||
    !exactRowKeys(controls[0]!, expectedKeys) ||
    controls[0]!.outputId !== evidence.controlOutputId
  )
    throw new Error("overview_previous_qualification_control_row_invalid");
  const control = controls[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    ENVELOPE_REPORT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error("overview_previous_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      `overview_previous_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reports.length,
    gateViolation: () =>
      new Error("overview_previous_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const hasDetail =
    evidence.configuration.kind === "overview-with-previous-and-detail";
  const expectedOutputs = new Set([
    CURRENT_AGGREGATE_OUTPUT,
    PREVIOUS_AGGREGATE_OUTPUT,
    ...(hasDetail ? [TREND_OUTPUT] : []),
  ]);
  const aggregateRows = new Map<string, Record<string, unknown>>();
  const trendRows: Record<string, unknown>[] = [];
  for (const row of reports) {
    if (
      !exactRowKeys(row, expectedKeys) ||
      typeof row.outputId !== "string" ||
      !expectedOutputs.has(row.outputId) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error("overview_previous_qualification_report_row_invalid");
    if (
      row.outputId === CURRENT_AGGREGATE_OUTPUT ||
      row.outputId === PREVIOUS_AGGREGATE_OUTPUT
    ) {
      if (
        row.bucket !== null ||
        !Number.isSafeInteger(row.views) ||
        !Number.isSafeInteger(row.sessions) ||
        !Number.isSafeInteger(row.visitors) ||
        !Number.isSafeInteger(row.bounces) ||
        !Number.isSafeInteger(row.durationViews)
      )
        throw new Error("overview_previous_qualification_aggregate_invalid");
      for (const field of [
        "views",
        "sessions",
        "visitors",
        "bounces",
        "durationViews",
      ])
        nonnegativeInteger(row[field], field);
      overviewMapperNumber(row.totalDuration, "totalDuration");
      if (aggregateRows.has(row.outputId))
        throw new Error(
          "overview_previous_qualification_report_cardinality_invalid",
        );
      aggregateRows.set(row.outputId, row);
      continue;
    }
    if (row.outputId !== TREND_OUTPUT)
      throw new Error("overview_previous_qualification_report_output_invalid");
    nonnegativeInteger(row.bucket, "bucket");
    for (const field of [
      "views",
      "visitors",
      "sessions",
      "bounces",
      "durationViews",
    ])
      nonnegativeInteger(row[field], field);
    overviewMapperNumber(row.totalDuration, "totalDuration");
    trendRows.push(row);
  }
  const orderedTrendRows = [...trendRows].sort(
    (left, right) => Number(left.bucket) - Number(right.bucket),
  );
  if (
    aggregateRows.size !== 2 ||
    !aggregateRows.has(CURRENT_AGGREGATE_OUTPUT) ||
    !aggregateRows.has(PREVIOUS_AGGREGATE_OUTPUT) ||
    new Set(orderedTrendRows.map((row) => row.bucket)).size !==
      orderedTrendRows.length
  )
    throw new Error(
      "overview_previous_qualification_report_cardinality_invalid",
    );
  return {
    kind: "executed",
    rows: Object.freeze([
      aggregateRows.get(CURRENT_AGGREGATE_OUTPUT)!,
      aggregateRows.get(PREVIOUS_AGGREGATE_OUTPUT)!,
      ...orderedTrendRows,
    ]),
    evidence,
  };
}

export async function executeOverviewPreviousQualificationProgram(input: {
  readonly env: Env;
  readonly query: CanonicalQuery<"overview">;
  readonly deferred: DeferredOverviewTrendQualification;
  readonly configuration: OverviewPreviousConfiguration;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<OverviewPreviousQualificationExecution> {
  const compilation = compileProgram(input);
  if (compilation.kind === "unavailable") return compilation;
  const rows = await executeQualificationQuery(
    input.deferred.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query as CompiledQuery<Record<string, unknown>>,
        input.diagnostics,
      ),
  );
  return decodeRows(rows, input.deferred, compilation.evidence);
}
