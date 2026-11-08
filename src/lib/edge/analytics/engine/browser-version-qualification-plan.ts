import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendBrowserVersionBreakdownReport,
  BROWSER_VERSION_BREAKDOWN_OUTPUT,
} from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT,
  type TechnologyRadarQualificationPlan,
} from "@/lib/edge/analytics/engine/technology-radar-qualification-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const BROWSER_VERSION_ATTRIBUTES = [
  "page.report.browser",
  "page.report.browserVersion",
  "page.report.visitorId",
  "page.report.sessionId",
] as const satisfies readonly SemanticAttributeId[];

/** Builds the qualified Page source and existing Browser-version report. */
export function buildBrowserVersionQualificationPlan(input: {
  readonly browserLimit: number;
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
    additionalAttributes: BROWSER_VERSION_ATTRIBUTES,
  });
  appendBrowserVersionBreakdownReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    browserLimit: input.browserLimit,
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
    reportOutputIds: [BROWSER_VERSION_BREAKDOWN_OUTPUT],
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
