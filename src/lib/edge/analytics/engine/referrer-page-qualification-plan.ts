import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  appendPageDimensionQualificationSource,
  PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import {
  appendReferrersPageReport,
  type ReferrerAggregateCursor,
  type ReferrerPageSortKey,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export type ReferrerPageQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> = AnalyticsQualificationPlan<Scope> & {
  readonly reportOutputIds: readonly ["referrers-page"];
};

/** Combines Count qualification with the original Referrer page report. */
export function buildReferrerPageQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly semanticOperation?: "dimension" | "filter-values";
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: Count;
  readonly eventCandidateReportProjection?: "page-visits";
  readonly options: {
    readonly limit: number;
    readonly includeFullUrl: boolean;
    readonly search?: string;
    readonly sortBy: ReferrerPageSortKey;
    readonly sortDirection: "asc" | "desc";
    readonly cursor: ReferrerAggregateCursor | null;
  };
}): ReferrerPageQualificationPlan<Count["scope"]> {
  const source = appendPageDimensionQualificationSource({
    ...(input.semanticOperation
      ? { semanticOperation: input.semanticOperation }
      : {}),
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode:
      input.eventCandidateReportProjection === "page-visits"
        ? "allow-whole-filter"
        : (input.filterMode ?? "split-only"),
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? {
          eventCandidateReportProjection: input.eventCandidateReportProjection,
        }
      : {}),
    selections: [],
    additionalAttributes: [
      "page.report.referrerHost",
      "page.report.referrerUrl",
    ],
  });
  appendReferrersPageReport(
    source.builder,
    source.qualifiedPages,
    input.options,
  );
  source.builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    Object.keys(source.qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  return {
    plan: source.builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: ["referrers-page"],
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
