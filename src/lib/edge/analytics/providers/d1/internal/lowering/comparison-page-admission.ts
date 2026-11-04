import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { AnalysisResultNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  LogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";

import type {
  AnalyticsQualificationAdmissionControlPolicy,
  AnalyticsQualificationAdmissionPolicy,
} from "./event-summary-admission";

export interface AnalysisResultQualificationBinding {
  readonly childPlan: LogicalPlan;
  readonly reportOutputIds: readonly string[];
  readonly controlsOutputId: string;
  readonly policy: AnalyticsQualificationAdmissionPolicy;
}

export interface ComparisonPageQualificationGateSide {
  readonly side: "current" | "reference";
  readonly controlsRelationId: RelationId;
  readonly controlSlots: readonly {
    readonly name: string;
    readonly slot: SlotId;
  }[];
  readonly policy: AnalyticsQualificationAdmissionControlPolicy;
}

export interface ComparisonPageQualificationGate {
  readonly reportRelationId: RelationId;
  readonly sides: readonly ComparisonPageQualificationGateSide[];
}

export interface ComparisonPageAdmissionBindings {
  readonly importedChildren: readonly AnalysisResultQualificationBinding[];
  readonly finalGate: ComparisonPageQualificationGate;
}

export interface ComparisonPageAdmissionSideInput {
  readonly kind: "qualified";
  readonly side: "current" | "reference";
  readonly qualification: AnalyticsQualificationPlan;
  readonly reportOutputId: string;
  readonly controlsOutputId: string;
  readonly parentControlsOutputId: string;
}

function one<T>(values: readonly T[], message: string): T {
  if (values.length !== 1) throw new Error(message);
  return values[0]!;
}

function outputById(plan: LogicalPlan, id: string): LogicalOutput {
  return one(
    plan.outputs.filter((output) => output.id === id),
    `comparison_page_output_invalid:${id}`,
  );
}

function expectedControlNames(
  qualification: AnalyticsQualificationPlan,
): readonly string[] {
  return [
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "entityKind",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    ...qualification.numericCompatibilityFields.map(
      ({ invalidCountOutput }) => invalidCountOutput,
    ),
  ];
}

function exactNameSet(actual: readonly string[], expected: readonly string[]) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function canonicalPlanValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalPlanValue);
  if (value instanceof Set)
    return [...value]
      .map(canonicalPlanValue)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  if (value instanceof Map)
    return [...value.entries()]
      .map(([key, item]) => [canonicalPlanValue(key), canonicalPlanValue(item)])
      .sort((left, right) =>
        JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])),
      );
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalPlanValue(record[key])]),
  );
}

function analysisImports(
  plan: LogicalPlan,
  outputId: string,
): AnalysisResultNode[] {
  return plan.nodes.filter(
    (node): node is AnalysisResultNode =>
      node.kind === "analysis-result" && node.outputId === outputId,
  );
}

function sideBindings(
  parentPlan: LogicalPlan,
  parentControlsOutputId: string,
  side: ComparisonPageAdmissionSideInput,
): {
  readonly child: AnalysisResultQualificationBinding;
  readonly gate: ComparisonPageQualificationGateSide;
} {
  const reportImport = one(
    analysisImports(parentPlan, side.reportOutputId),
    `comparison_page_report_import_invalid:${side.reportOutputId}`,
  );
  const controlImport = one(
    analysisImports(parentPlan, side.controlsOutputId),
    `comparison_page_controls_import_invalid:${side.controlsOutputId}`,
  );
  if (reportImport.childPlan !== controlImport.childPlan)
    throw new Error("comparison_page_child_snapshot_mismatch");

  const childPlan = reportImport.childPlan;
  if (
    !Object.isFrozen(childPlan) ||
    !Object.isFrozen(childPlan.nodes) ||
    !Object.isFrozen(childPlan.outputs) ||
    JSON.stringify(canonicalPlanValue(childPlan)) !==
      JSON.stringify(canonicalPlanValue(side.qualification.plan))
  )
    throw new Error("comparison_page_child_snapshot_unverified");
  if (childPlan.nodes.some((node) => node.kind === "analysis-result"))
    throw new Error("comparison_page_nested_child_import_unsupported");
  const reportOutput = outputById(childPlan, side.reportOutputId);
  const controlsOutput = outputById(childPlan, side.controlsOutputId);
  if (
    !exactNameSet(
      reportOutput.fields.map(({ name }) => name),
      ["value", "views", "sessions", "visitors"],
    ) ||
    reportOutput.fields.length !== 4
  )
    throw new Error("comparison_page_child_report_schema_invalid");
  const expectedControls = expectedControlNames(side.qualification);
  const controlNames = controlsOutput.fields.map(({ name }) => name);
  if (
    !exactNameSet(controlNames, expectedControls) ||
    controlsOutput.fields.length !== expectedControls.length ||
    new Set(controlNames).size !== controlNames.length
  )
    throw new Error("comparison_page_child_controls_schema_invalid");
  if (
    reportImport.mappings.length !== 4 ||
    !exactNameSet(
      reportImport.mappings.map(({ field }) => field),
      ["value", "views", "sessions", "visitors"],
    ) ||
    !exactNameSet(
      controlImport.mappings.map(({ field }) => field),
      expectedControls,
    ) ||
    controlImport.mappings.length !== expectedControls.length
  )
    throw new Error("comparison_page_import_mapping_invalid");

  const primary = childPlan.nodes.find(
    (node) => node.id === side.qualification.primaryReportSourceRelationId,
  );
  const reportRelation = childPlan.nodes.find(
    (node) => node.id === reportOutput.relation,
  );
  if (
    primary?.kind !== "source" ||
    primary.entity !== "page" ||
    reportRelation?.grain.kind !== "keyed" ||
    reportOutput.fields.some(
      ({ slot }) => !reportRelation.output.includes(slot),
    ) ||
    !side.qualification.reportSourceRelations.some(
      ({ relationId, entity }) =>
        relationId === primary.id && entity === "page",
    ) ||
    side.qualification.reportSourceRelations.length !== 1 ||
    !childPlan.nodes.some(
      (node) => node.id === side.qualification.controlsRelationId,
    ) ||
    !childPlan.nodes.some(
      (node) => node.id === side.qualification.matchesRelationId,
    ) ||
    !childPlan.nodes.some(
      (node) => node.id === side.qualification.groupedSummaryRelationId,
    ) ||
    controlsOutput.relation !== side.qualification.controlsRelationId
  )
    throw new Error("comparison_page_child_source_proof_invalid");

  const controlsRelation = childPlan.nodes.find(
    (node) => node.id === controlsOutput.relation,
  );
  if (
    !controlsRelation ||
    controlsRelation.output.length !== controlsOutput.fields.length ||
    controlsOutput.fields.some(
      ({ slot }) => !controlsRelation.output.includes(slot),
    )
  )
    throw new Error("comparison_page_child_control_slots_invalid");

  const policy: AnalyticsQualificationAdmissionPolicy = {
    primaryReportSourceRelationId:
      side.qualification.primaryReportSourceRelationId,
    reportSourceRelations: side.qualification.reportSourceRelations,
    reportRelationIds: [reportOutput.relation],
    controlsRelationId: controlsOutput.relation,
    controlSlots: controlsOutput.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: side.qualification.scope,
    maximumActivities: 20_000,
    numericCompatibilityControlNames:
      side.qualification.numericCompatibilityFields.map(
        ({ invalidCountOutput }) => invalidCountOutput,
      ),
  };
  const importedControlsOutput = outputById(parentPlan, parentControlsOutputId);
  if (
    importedControlsOutput.relation !== controlImport.id ||
    !exactNameSet(
      importedControlsOutput.fields.map(({ name }) => name),
      expectedControls,
    ) ||
    importedControlsOutput.fields.length !== expectedControls.length
  )
    throw new Error("comparison_page_parent_control_output_invalid");
  return {
    child: {
      childPlan,
      reportOutputIds: [side.reportOutputId],
      controlsOutputId: side.controlsOutputId,
      policy,
    },
    gate: {
      side: side.side,
      controlsRelationId: importedControlsOutput.relation,
      controlSlots: importedControlsOutput.fields.map(({ name, slot }) => ({
        name,
        slot,
      })),
      policy,
    },
  };
}

export function createComparisonPageAdmissionBindings(input: {
  readonly parentPlan: LogicalPlan;
  readonly reportOutputId: string;
  readonly qualifiedSides: readonly ComparisonPageAdmissionSideInput[];
}): ComparisonPageAdmissionBindings {
  if (
    input.qualifiedSides.length < 1 ||
    input.qualifiedSides.length > 2 ||
    new Set(input.qualifiedSides.map(({ side }) => side)).size !==
      input.qualifiedSides.length
  )
    throw new Error("comparison_page_qualification_sides_invalid");
  const report = outputById(input.parentPlan, input.reportOutputId);
  if (
    !exactNameSet(
      report.fields.map(({ name }) => name),
      [
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
      ],
    ) ||
    report.fields.length !== 10
  )
    throw new Error("comparison_page_report_output_schema_invalid");
  const sides = input.qualifiedSides.map((side) =>
    sideBindings(input.parentPlan, side.parentControlsOutputId, side),
  );
  if (new Set(sides.map(({ child }) => child.childPlan)).size !== sides.length)
    throw new Error("comparison_page_child_sides_not_independent");
  return {
    importedChildren: sides.map(({ child }) => child),
    finalGate: {
      reportRelationId: report.relation,
      sides: sides.map(({ gate }) => gate),
    },
  };
}
