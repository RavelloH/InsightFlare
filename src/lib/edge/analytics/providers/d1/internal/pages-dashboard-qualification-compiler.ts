import type { QueryInput } from "@/lib/edge/analytics/contract";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type {
  LogicalOutput,
  LogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPagesDashboardQualificationPlan,
  PAGES_DASHBOARD_QUALIFICATION_OUTPUTS,
  PAGES_DASHBOARD_REPORT_FIELDS,
  PAGES_DASHBOARD_TITLE_OUTPUT_FIELDS,
  PAGES_DASHBOARD_TREND_OUTPUT_FIELDS,
  type PagesDashboardQualificationInput,
  type PagesDashboardQualificationPlan,
} from "@/lib/edge/analytics/engine/pages-dashboard-qualification-plan";
import type { AnalysisResultQualificationBinding } from "@/lib/edge/analytics/providers/d1/internal/lowering/comparison-page-admission";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";

import type { AdvancedCountSqlFallbackReason } from "./diagnostics";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilation,
  type QualificationEnvelopeQualification,
} from "./qualification-program-envelope";

function exactOutput(plan: LogicalPlan, outputId: string): LogicalOutput {
  const outputs = plan.outputs.filter((output) => output.id === outputId);
  if (outputs.length !== 1)
    throw new Error(`pages_dashboard_qualification_output:${outputId}`);
  return outputs[0]!;
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
    throw new Error("pages_dashboard_qualification_child_snapshot_invalid");
  return unique[0]!;
}

function childBinding(input: {
  readonly qualification: PagesDashboardQualificationPlan;
  readonly childPlan: LogicalPlan;
}): AnalysisResultQualificationBinding {
  const childQualification = input.qualification.childQualification;
  const controls = exactOutput(
    input.childPlan,
    childQualification.controlOutputId,
  );
  const reports = childQualification.reportOutputIds.map((outputId) =>
    exactOutput(input.childPlan, outputId),
  );
  const policy: AnalyticsQualificationAdmissionPolicy = {
    primaryReportSourceRelationId:
      childQualification.primaryReportSourceRelationId,
    reportSourceRelations: childQualification.reportSourceRelations,
    reportRelationIds: reports.map(({ relation }) => relation),
    controlsRelationId: controls.relation,
    controlSlots: controls.fields.map(({ name, slot }) => ({ name, slot })),
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
    controlsOutputId: childQualification.controlOutputId,
    policy,
  };
}

function compile(input: PagesDashboardQualificationInput):
  | QualificationEnvelopeCompilation
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
      readonly qualification: PagesDashboardQualificationPlan;
    } {
  const qualification = buildPagesDashboardQualificationPlan(input);
  const currentOutput = exactOutput(
    qualification.plan,
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
  );
  const titleOutput = exactOutput(
    qualification.plan,
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
  );
  const trendOutput = exactOutput(
    qualification.plan,
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
  );
  const controlsOutput = exactOutput(
    qualification.plan,
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.controls,
  );
  const childOutputIds = new Set([
    ...qualification.childQualification.reportOutputIds,
    qualification.childQualification.controlOutputId,
  ]);
  const childPlan = importedChildSnapshot(qualification.plan, childOutputIds);
  const binding = childBinding({ qualification, childPlan });
  const envelopeQualification: QualificationEnvelopeQualification = {
    plan: qualification.plan,
    primaryReportSourceRelationId: qualification.primaryReportSourceRelationId,
    controlsRelationId: controlsOutput.relation,
    controlOutputId: qualification.controlOutputId,
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: qualification.reportSourceRelations,
  };
  const compilation = compileQualificationProgramEnvelope({
    qualification: envelopeQualification,
    siteId: input.siteId,
    reports: [
      {
        output: currentOutput,
        fields: PAGES_DASHBOARD_REPORT_FIELDS.filter(
          (field) => field !== "bucket" && field !== "title",
        ),
        rowType: "pages-dashboard-current",
      },
      {
        output: titleOutput,
        fields: PAGES_DASHBOARD_TITLE_OUTPUT_FIELDS,
        rowType: "pages-dashboard-title",
      },
      {
        output: trendOutput,
        fields: PAGES_DASHBOARD_TREND_OUTPUT_FIELDS,
        rowType: "pages-dashboard-trend",
      },
    ],
    controlsOutput,
    reportFields: PAGES_DASHBOARD_REPORT_FIELDS,
    controlFields: controlsOutput.fields.map(({ name }) => name),
    ordering: [
      { field: "rowOrder", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
      { field: "pathname", direction: "asc", nulls: "first" },
    ],
    errorPrefix: "pages_dashboard_qualification",
    fallbackTag: "analytics.pages_dashboard_qualification",
    analysisResultQualificationBindings: [binding],
    importedGroupedSummaryReference: Object.freeze({
      kind: "imported-child",
      childPlan,
      relationId: qualification.childQualification.groupedSummaryRelationId,
    }),
  });
  return compilation.kind === "compiled"
    ? compilation
    : { ...compilation, qualification };
}

/** Pure compile preflight for the complete non-comparison dashboard shape. */
export function compilePagesDashboardQualificationProgram(input: {
  readonly query: QueryInput & Record<string, unknown>;
  readonly qualification: Omit<PagesDashboardQualificationInput, "siteId"> & {
    readonly siteId: string;
  };
}) {
  if (
    input.query.time !== input.qualification.queryTime ||
    input.query.filters !== input.qualification.filters ||
    input.query.scopePlan !== input.qualification.scopePlan
  )
    throw new Error("pages_dashboard_qualification_request_changed");
  return compile(input.qualification);
}

export type PagesDashboardQualificationCompilation = ReturnType<
  typeof compilePagesDashboardQualificationProgram
>;
