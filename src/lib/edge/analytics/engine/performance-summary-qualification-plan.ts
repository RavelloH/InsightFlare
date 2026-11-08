import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  appendPerformanceSummariesReport,
  PERFORMANCE_METRICS,
  PERFORMANCE_SUMMARY_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const PERFORMANCE_SUMMARY_QUALIFICATION_CONTROL_OUTPUT =
  "performance-summary-qualification-controls";

export type PerformanceSummaryQualificationPlan = AnalyticsQualificationPlan<
  "session" | "visitor" | "event"
> & {
  readonly reportOutputIds: readonly [typeof PERFORMANCE_SUMMARY_OUTPUT_ID];
};

const PERFORMANCE_PAGE_ATTRIBUTES: readonly SemanticAttributeId[] = [
  "page.report.sessionId",
  "page.report.visitorId",
  ...PERFORMANCE_METRICS.map(
    ({ attribute }) => ("page.report." + attribute) as SemanticAttributeId,
  ),
];

export function buildPerformanceSummaryQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
}): PerformanceSummaryQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "performance",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : (input.filterMode ?? "split-only"),
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [],
    additionalAttributes: PERFORMANCE_PAGE_ATTRIBUTES,
  });
  const { builder, qualification, qualifiedPages } = source;
  appendPerformanceSummariesReport(builder, qualifiedPages);
  builder.output(
    PERFORMANCE_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PERFORMANCE_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [PERFORMANCE_SUMMARY_OUTPUT_ID],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
