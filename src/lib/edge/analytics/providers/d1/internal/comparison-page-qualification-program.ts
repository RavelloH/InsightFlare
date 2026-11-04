import type { CompiledQuery } from "@/lib/db";
import {
  compileD1Query,
  constant,
  lowerLogicalPlan,
  project,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import type {
  FilterDocument,
  QueryAudience,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import type { QueryInput } from "@/lib/edge/analytics/contract";
import {
  buildQualifiedComparisonPagePlan,
  COMPARISON_PAGE_CURRENT_CHILD_CONTROLS_OUTPUT,
  COMPARISON_PAGE_CURRENT_CONTROLS_OUTPUT,
  COMPARISON_PAGE_CURRENT_ROLLUP_OUTPUT,
  COMPARISON_PAGE_OUTPUT_ID,
  COMPARISON_PAGE_REFERENCE_CHILD_CONTROLS_OUTPUT,
  COMPARISON_PAGE_REFERENCE_CONTROLS_OUTPUT,
  COMPARISON_PAGE_REFERENCE_ROLLUP_OUTPUT,
  type ComparisonDimensionCursor,
} from "@/lib/edge/analytics/engine/comparison-report-plan";
import { buildComparisonPageDimensionQualificationPlan } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { buildSessionBoundaryComparisonQualificationPlan } from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import { SESSION_PATH_COMPARISON_ROLLUP_OUTPUT } from "@/lib/edge/analytics/engine/session-path-report-plan";
import type { Env } from "@/lib/edge/types";

import {
  type ComparisonPageAdmissionSideInput,
  createComparisonPageAdmissionBindings,
} from "./lowering/comparison-page-admission";
import {
  type DeferredComparisonPageQualification,
  deferredComparisonPageQualificationFromQuery,
  type DeferredComparisonPageSide,
  isDeferredComparisonPageQualification,
} from "./advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "./analytics-relational-lowering";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import {
  buildComparisonDimensionRollupPlan,
  COMPARISON_DIMENSION_ROLLUP_OUTPUT,
} from "./comparison-dimension-source";
import {
  type ComparisonDimensionPage,
  comparisonPageFromRows,
} from "./comparison-page-result";
import { buildComparisonSessionPathPlan } from "./comparison-session-path-source";
import { queryD1CompiledAll } from "./core";
import type { QueryWindow } from "./core-types";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import { qualificationCompatibilityFieldsFromNumeric } from "./qualification-compatibility";
import {
  compileQualificationQuery,
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";
export type QualifiedComparisonDimensionExecution =
  | {
      readonly kind: "executed";
      readonly page: ComparisonDimensionPage;
      readonly evidence: {
        readonly statementTag: string;
        readonly sqlBytes: number;
        readonly bindingCount: number;
        readonly sharedRelationCount: number;
      };
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

const COMPARISON_REPORT_FIELDS = [
  "key",
  "currentViews",
  "currentSessions",
  "currentVisitors",
  "referenceViews",
  "referenceSessions",
  "referenceVisitors",
  "sortClass",
  "sortPrimary",
  "sortSecondary",
] as const;
type ComparisonPageSide = "current" | "reference";

function deferredSideFilters(side: DeferredComparisonPageSide): FilterDocument {
  return side.kind === "qualified" ? side.qualification.filters : side.filters;
}

function deferredSideTime(side: DeferredComparisonPageSide): QueryTime {
  return side.kind === "qualified" ? side.qualification.time : side.time;
}

function exactComparisonRowKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function taggedComparisonBranch(
  relation: AnalyticsDbRelation,
  rowKind: string,
  outputId: string,
  controlNames: Partial<Record<ComparisonPageSide, readonly string[]>>,
  report: boolean,
  side?: "current" | "reference",
) {
  const projections: Record<string, AnyExpression> = {
    rowKind: constant(rowKind),
    outputId: constant(outputId),
  };
  for (const field of COMPARISON_REPORT_FIELDS)
    projections[field] = report ? relation.columns[field]! : constant(null);
  for (const controlSide of ["current", "reference"] as const) {
    for (const name of controlNames[controlSide] ?? []) {
      const field = `${controlSide}__${name}`;
      projections[field] =
        side === controlSide ? relation.columns[name]! : constant(null);
    }
  }
  return project(relation, projections);
}

async function executeQualifiedComparisonDimensionProgram(input: {
  readonly env: Env;
  readonly request: QueryInput;
  readonly siteId: string;
  readonly current: QueryWindow;
  readonly currentFilters: FilterDocument;
  readonly reference: QueryWindow;
  readonly referenceFilters: FilterDocument;
  readonly selectExpr: string;
  readonly audience: QueryAudience;
  readonly cursor: ComparisonDimensionCursor | null;
  readonly cursorToken: string | null;
  readonly deferred: DeferredComparisonPageQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedComparisonDimensionExecution> {
  const deferred = input.deferred;
  const currentTime = deferredSideTime(deferred.current);
  const referenceTime = deferredSideTime(deferred.reference);
  const matchesWindow = (time: QueryTime, window: QueryWindow) =>
    time.range.startMs === window.startMs &&
    time.range.endExclusiveMs === window.endExclusiveMs &&
    time.reportingTimeZone === window.timeZone &&
    time.capturedAtMs === window.nowMs;
  if (
    !isDeferredComparisonPageQualification(deferred) ||
    deferredComparisonPageQualificationFromQuery(input.request) !== deferred ||
    deferred.operation !== "dimension" ||
    deferredSideFilters(deferred.current) !== input.currentFilters ||
    deferredSideFilters(deferred.reference) !== input.referenceFilters ||
    !matchesWindow(currentTime, input.current) ||
    !matchesWindow(referenceTime, input.reference) ||
    (deferred.current.kind === "qualified" &&
      deferred.current.qualification.siteId !== input.siteId) ||
    (deferred.reference.kind === "qualified" &&
      deferred.reference.qualification.siteId !== input.siteId) ||
    deferred.expression !== input.selectExpr ||
    deferred.cursorToken !== input.cursorToken ||
    deferred.audience !== input.audience
  )
    throw new Error("comparison_page_qualification_request_mismatch");

  const buildQualifiedSide = (
    side: DeferredComparisonPageSide,
    reportOutputId: string,
    controlsOutputId: string,
  ) => {
    if (side.kind !== "qualified") return undefined;
    const qualification = side.qualification;
    const common = {
      siteId: input.siteId,
      queryTime: qualification.time,
      filters: qualification.filters,
      scopePlan: qualification.metadata.plan,
      count: qualification.countInput,
    };
    return deferred.reportFamily.kind === "page-dimension"
      ? buildComparisonPageDimensionQualificationPlan({
          ...common,
          selection: deferred.reportFamily.selection,
          reportOutputId,
          controlsOutputId,
        })
      : buildSessionBoundaryComparisonQualificationPlan({
          ...common,
          kind: deferred.reportFamily.pathKind,
          reportOutputId,
          controlsOutputId,
        });
  };
  const currentQualification = buildQualifiedSide(
    deferred.current,
    COMPARISON_PAGE_CURRENT_ROLLUP_OUTPUT,
    COMPARISON_PAGE_CURRENT_CHILD_CONTROLS_OUTPUT,
  );
  const referenceQualification = buildQualifiedSide(
    deferred.reference,
    COMPARISON_PAGE_REFERENCE_ROLLUP_OUTPUT,
    COMPARISON_PAGE_REFERENCE_CHILD_CONTROLS_OUTPUT,
  );
  const nativeReportOutputId =
    deferred.reportFamily.kind === "session-boundary"
      ? SESSION_PATH_COMPARISON_ROLLUP_OUTPUT
      : COMPARISON_DIMENSION_ROLLUP_OUTPUT;
  const currentReportOutputId = currentQualification
    ? COMPARISON_PAGE_CURRENT_ROLLUP_OUTPUT
    : nativeReportOutputId;
  const referenceReportOutputId = referenceQualification
    ? COMPARISON_PAGE_REFERENCE_ROLLUP_OUTPUT
    : nativeReportOutputId;
  const nativePlan = (window: QueryWindow, filters: FilterDocument) =>
    deferred.reportFamily.kind === "page-dimension"
      ? buildComparisonDimensionRollupPlan({
          siteId: input.siteId,
          window,
          filters,
          selection: deferred.reportFamily.selection,
        })
      : buildComparisonSessionPathPlan({
          siteId: input.siteId,
          window,
          filters,
          kind: deferred.reportFamily.pathKind,
        });
  const currentPlan =
    currentQualification?.plan ??
    nativePlan(input.current, input.currentFilters);
  const referencePlan =
    referenceQualification?.plan ??
    nativePlan(input.reference, input.referenceFilters);
  const plan = buildQualifiedComparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    currentReportOutputId,
    referenceReportOutputId,
    ...(currentQualification
      ? {
          currentControlsOutputId:
            COMPARISON_PAGE_CURRENT_CHILD_CONTROLS_OUTPUT,
        }
      : {}),
    ...(referenceQualification
      ? {
          referenceControlsOutputId:
            COMPARISON_PAGE_REFERENCE_CHILD_CONTROLS_OUTPUT,
        }
      : {}),
    metric: deferred.metric,
    sortBy: deferred.sortBy,
    direction: deferred.direction,
    search: deferred.search,
    cursor: input.cursor,
    limit: deferred.limit,
  });
  const qualifiedSides: ComparisonPageAdmissionSideInput[] = [];
  if (currentQualification)
    qualifiedSides.push({
      kind: "qualified",
      side: "current",
      qualification: currentQualification,
      reportOutputId: COMPARISON_PAGE_CURRENT_ROLLUP_OUTPUT,
      controlsOutputId: COMPARISON_PAGE_CURRENT_CHILD_CONTROLS_OUTPUT,
      parentControlsOutputId: COMPARISON_PAGE_CURRENT_CONTROLS_OUTPUT,
    });
  if (referenceQualification)
    qualifiedSides.push({
      kind: "qualified",
      side: "reference",
      qualification: referenceQualification,
      reportOutputId: COMPARISON_PAGE_REFERENCE_ROLLUP_OUTPUT,
      controlsOutputId: COMPARISON_PAGE_REFERENCE_CHILD_CONTROLS_OUTPUT,
      parentControlsOutputId: COMPARISON_PAGE_REFERENCE_CONTROLS_OUTPUT,
    });
  const admission = createComparisonPageAdmissionBindings({
    parentPlan: plan,
    reportOutputId: COMPARISON_PAGE_OUTPUT_ID,
    qualifiedSides,
  });
  const siteIds = plan.context.subject.siteIds;
  if (siteIds.length !== 1 || siteIds[0] !== input.siteId)
    throw new Error("comparison_page_qualification_site_subject_invalid");
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    { siteId: input.siteId, time: plan.context.time },
    {
      analysisResultQualificationBindings: admission.importedChildren,
      comparisonPageQualificationGate: admission.finalGate,
    },
  );
  const reportOutput = plan.outputs.find(
    (output) => output.id === COMPARISON_PAGE_OUTPUT_ID,
  );
  const controlsOutputs = qualifiedSides.map((side) => {
    const output = plan.outputs.find(
      (candidate) => candidate.id === side.parentControlsOutputId,
    );
    if (!output)
      throw new Error("comparison_page_qualification_outputs_missing");
    return output;
  });
  if (!reportOutput)
    throw new Error("comparison_page_qualification_outputs_missing");
  const lowered = lowerer.lowerMany([reportOutput, ...controlsOutputs]);
  const reportRelation = lowerer.projectOutput(
    lowered[0]!,
    reportOutput.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const controlNames: Partial<Record<ComparisonPageSide, readonly string[]>> =
    {};
  const controlRelations = qualifiedSides.map((side, index) => {
    const childControls = side.qualification.plan.outputs.find(
      (output) => output.id === side.controlsOutputId,
    );
    const parentControls = controlsOutputs[index]!;
    if (!childControls)
      throw new Error("comparison_page_qualification_outputs_missing");
    controlNames[side.side] = childControls.fields.map(({ name }) => name);
    return {
      side: side.side,
      outputId: side.parentControlsOutputId,
      relation: lowerer.projectOutput(
        lowered[index + 1]!,
        parentControls.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    };
  });
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...COMPARISON_REPORT_FIELDS,
    ...qualifiedSides.flatMap((side) =>
      (controlNames[side.side] ?? []).map((name) => `${side.side}__${name}`),
    ),
  ];
  const branches = [
    taggedComparisonBranch(
      reportRelation,
      "report",
      COMPARISON_PAGE_OUTPUT_ID,
      controlNames,
      true,
    ),
  ];
  for (const entry of controlRelations)
    branches.push(
      taggedComparisonBranch(
        entry.relation,
        `${entry.side}-control`,
        entry.outputId,
        controlNames,
        false,
        entry.side,
      ),
    );
  let envelope: AnalyticsDbRelation = branches[0]!;
  for (const branch of branches.slice(1))
    envelope = union(envelope, branch, true) as AnalyticsDbRelation;
  const ordered = sort(envelope, [
    { expression: envelope.columns.rowKind!, direction: "ASC" },
    ...(deferred.sortBy === "change"
      ? [
          {
            expression: envelope.columns.sortClass!,
            direction:
              deferred.direction === "asc"
                ? ("ASC" as const)
                : ("DESC" as const),
          },
          {
            expression: envelope.columns.sortPrimary!,
            direction:
              deferred.direction === "asc"
                ? ("ASC" as const)
                : ("DESC" as const),
          },
        ]
      : [
          {
            expression: envelope.columns.sortPrimary!,
            direction:
              deferred.direction === "asc"
                ? ("ASC" as const)
                : ("DESC" as const),
          },
          {
            expression: envelope.columns.sortSecondary!,
            direction:
              deferred.direction === "asc"
                ? ("ASC" as const)
                : ("DESC" as const),
          },
        ]),
    { expression: envelope.columns.key!, direction: "ASC" },
  ]);
  if (Object.keys(envelope.columns).length !== envelopeFields.length)
    throw new Error("comparison_page_qualification_envelope_schema_invalid");

  const signals = [
    ...(deferred.current.kind === "qualified"
      ? [deferred.current.qualification.signal]
      : []),
    ...(deferred.reference.kind === "qualified"
      ? [deferred.reference.qualification.signal]
      : []),
  ];
  const physical = lowerLogicalPlan(ordered);
  const compilation = compileQualificationQuery(
    () =>
      compileD1Query(physical, {
        tag: "analytics.comparison_page_qualification",
      }) as CompiledQuery<Record<string, unknown>>,
    signals,
  );
  if (compilation.kind === "unavailable") return compilation;
  const { query } = compilation;
  const rows = await executeQualificationQuery(signals, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      query,
      input.diagnostics,
    ),
  );
  const controlKeys = qualifiedSides.flatMap((side) =>
    (controlNames[side.side] ?? []).map((name) => `${side.side}__${name}`),
  );
  const expectedRowKeys = [
    "rowKind",
    "outputId",
    ...COMPARISON_REPORT_FIELDS,
    ...controlKeys,
  ];
  const reportRows = rows.filter((row) => row.rowKind === "report");
  const controlRows = new Map<ComparisonPageSide, Record<string, unknown>[]>();
  for (const side of qualifiedSides)
    controlRows.set(
      side.side,
      rows.filter((row) => row.rowKind === `${side.side}-control`),
    );
  if (
    rows.length !== reportRows.length + qualifiedSides.length ||
    qualifiedSides.some((side) => controlRows.get(side.side)?.length !== 1) ||
    !rows.every((row) => exactComparisonRowKeys(row, expectedRowKeys))
  )
    throw new Error("comparison_page_qualification_envelope_invalid");
  for (const side of qualifiedSides)
    if (
      controlRows.get(side.side)![0]!.outputId !== side.parentControlsOutputId
    )
      throw new Error("comparison_page_qualification_control_output_invalid");
  for (const row of reportRows) {
    if (
      row.outputId !== COMPARISON_PAGE_OUTPUT_ID ||
      typeof row.key !== "string" ||
      ![
        "currentViews",
        "currentSessions",
        "currentVisitors",
        "referenceViews",
        "referenceSessions",
        "referenceVisitors",
      ].every(
        (field) =>
          typeof row[field] === "number" && Number.isFinite(row[field]),
      ) ||
      typeof row.sortClass !== "number" ||
      !Number.isFinite(row.sortClass) ||
      (row.sortPrimary !== null &&
        (typeof row.sortPrimary !== "number" ||
          !Number.isFinite(row.sortPrimary))) ||
      typeof row.sortSecondary !== "number" ||
      !Number.isFinite(row.sortSecondary) ||
      controlKeys.some((field) => row[field] !== null)
    )
      throw new Error("comparison_page_qualification_report_row_invalid");
  }
  const decodedControls = qualifiedSides.map((side) => {
    const deferredSide =
      side.side === "current" ? deferred.current : deferred.reference;
    if (deferredSide.kind !== "qualified")
      throw new Error("comparison_page_qualification_side_invalid");
    const row = controlRows.get(side.side)![0]!;
    const ownControlKeys = (controlNames[side.side] ?? []).map(
      (name) => `${side.side}__${name}`,
    );
    if (
      COMPARISON_REPORT_FIELDS.some((field) => row[field] !== null) ||
      controlKeys.some(
        (field) => !ownControlKeys.includes(field) && row[field] !== null,
      )
    )
      throw new Error("comparison_page_qualification_control_row_invalid");
    if (
      row[`${side.side}__entityKind`] !==
      deferredSide.qualification.countInput.scope
    )
      throw new Error("comparison_page_qualification_control_scope_mismatch");
    return {
      side: side.side,
      decoded: decodeQualificationControl({
        read: (field) => row[`${side.side}__${field}`],
        compatibilityFields: qualificationCompatibilityFieldsFromNumeric(
          side.qualification.numericCompatibilityFields,
        ),
        errorLabel: (field) =>
          `comparison_page_qualification_control_invalid:${side.side}.${field}`,
      }),
    };
  });

  for (const { side, decoded } of decodedControls) {
    const judgment = judgeQualificationControl(decoded, {
      reportRowCount: reportRows.length,
      gateViolation: () =>
        new Error("comparison_page_qualification_gate_violation"),
      invalidIdentity: () =>
        new Error(`comparison_page_qualification_${side}_identity_invalid`),
      duplicateIdentity: () =>
        new Error(`comparison_page_qualification_${side}_identity_repeated`),
    });
    if (judgment.kind === "fallback") {
      if (input.diagnostics)
        input.diagnostics.advancedCountSqlFallbackReason =
          judgment.fallbackReason;
      return { kind: "unavailable", fallbackReason: judgment.fallbackReason };
    }
  }

  const page = await comparisonPageFromRows({
    env: input.env,
    rows: reportRows,
    limit: deferred.limit,
    siteId: input.siteId,
    current: input.current,
    currentFilters: input.currentFilters,
    reference: input.reference,
    referenceFilters: input.referenceFilters,
    selectExpr: input.selectExpr,
    search: deferred.search,
    audience: input.audience,
    metric: deferred.metric,
    sortBy: deferred.sortBy,
    direction: deferred.direction,
  });
  if (input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = undefined;
  return {
    kind: "executed",
    page,
    evidence: {
      statementTag: query.tag ?? "analytics.comparison_page_qualification",
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindingCount: query.bindings?.length ?? 0,
      sharedRelationCount: physical.sharedRelations.length,
    },
  };
}

export async function tryQueryQualifiedComparisonDimensionPageFromD1(input: {
  readonly env: Env;
  readonly request: QueryInput;
  readonly siteId: string;
  readonly current: QueryWindow;
  readonly currentFilters: FilterDocument;
  readonly reference: QueryWindow;
  readonly referenceFilters: FilterDocument;
  readonly selectExpr: string;
  readonly audience: QueryAudience;
  readonly cursor: ComparisonDimensionCursor | null;
  readonly cursorToken: string | null;
  readonly deferred: DeferredComparisonPageQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedComparisonDimensionExecution> {
  const result = await executeQualifiedComparisonDimensionProgram(input);
  if (result.kind === "unavailable" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = result.fallbackReason;
  return result;
}
