import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  appendTechnologyRadarReport,
  TECHNOLOGY_RADAR_OUTPUTS,
  type TechnologyRadarDimensionQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT =
  "technology-radar-qualification-controls";

export type TechnologyRadarQualificationPlan = AnalyticsQualificationPlan<
  "session" | "visitor" | "event"
> & {
  readonly reportOutputIds: readonly [string];
};

const RADAR_ATTRIBUTES = [
  "page.report.browser",
  "page.report.referrerHost",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.durationMs",
] as const satisfies readonly SemanticAttributeId[];

/** Builds one reader-window Page bag, one qualified report, and its controls. */
export function buildTechnologyRadarQualificationPlan(input: {
  readonly configuration: TechnologyRadarDimensionQualificationConfiguration;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
}): TechnologyRadarQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "radar",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : input.filterMode,
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [],
    additionalAttributes: RADAR_ATTRIBUTES,
  });
  appendTechnologyRadarReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    dimension: input.configuration.dimension,
    ...(input.configuration.dimension === "referrer"
      ? { limit: input.configuration.limit }
      : {}),
  });
  const controlFields = Object.keys(source.qualification.controls.slots).map(
    (name) => ({ name, slot: name }),
  );
  source.builder.output(
    TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    controlFields,
  );
  return {
    plan: source.builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [TECHNOLOGY_RADAR_OUTPUTS[input.configuration.dimension]],
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
