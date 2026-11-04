import type {
  Interval,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendJourneyRetentionReport } from "@/lib/edge/analytics/engine/journey-retention-report-plan";
import {
  appendPageDimensionQualificationSource,
  PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const JOURNEY_RETENTION_QUALIFICATION_OUTPUT = "journey-retention";

export type JourneyRetentionQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly [
    typeof JOURNEY_RETENTION_QUALIFICATION_OUTPUT,
  ];
};

/** Reuses one Count-qualified Page relation for both cohort and tracking. */
export function buildJourneyRetentionQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly granularity: Interval;
  readonly filterMode?: QualifiedSourceFilterMode;
}): JourneyRetentionQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "retention",
    filterMode: input.filterMode ?? "split-only",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: ["page.report.visitorId", "page.report.startedAt"],
  });
  const { builder, qualification, qualifiedPages } = source;
  appendJourneyRetentionReport(
    builder,
    qualifiedPages,
    qualifiedPages,
    input.granularity,
  );
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
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
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [JOURNEY_RETENTION_QUALIFICATION_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}
