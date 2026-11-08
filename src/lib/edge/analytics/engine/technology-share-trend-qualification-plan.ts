import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  appendTechnologyShareTrendReport,
  type SelectedTrendDimension,
  TECHNOLOGY_SHARE_TREND_DIMENSIONS,
  TECHNOLOGY_SHARE_TREND_OUTPUTS,
  type TechnologyShareTrendQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const TECHNOLOGY_SHARE_TREND_QUALIFICATION_CONTROL_OUTPUT =
  "technology-share-trend-qualification-controls";

export type TechnologyShareTrendQualificationPlan = AnalyticsQualificationPlan<
  "session" | "visitor" | "event"
> & {
  readonly reportOutputIds: readonly string[];
};

const READER_ATTRIBUTES = [
  "page.report.startedAt",
  "page.report.localId",
] as const satisfies readonly SemanticAttributeId[];

function selectedDimensions(
  configuration: TechnologyShareTrendQualificationConfiguration,
): readonly SelectedTrendDimension[] {
  if (configuration.kind === "single")
    return [{ kind: "single", dimension: configuration.dimension }];
  return [
    { kind: "source", dimension: "referrerDomain" },
    { kind: "channel", dimension: "trafficChannel" },
  ];
}

function outputIds(
  dimensions: readonly SelectedTrendDimension[],
): readonly string[] {
  return dimensions.flatMap(({ kind }) => {
    const outputs = TECHNOLOGY_SHARE_TREND_OUTPUTS[kind];
    return [outputs.top, outputs.series, outputs.bucket];
  });
}

/** Builds one qualified Page bag and the existing single/dual report outputs. */
export function buildTechnologyShareTrendQualificationPlan(input: {
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
}): TechnologyShareTrendQualificationPlan {
  const dimensions = selectedDimensions(input.configuration);
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "share-trend",
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
    selections: dimensions.map(
      ({ dimension }) => TECHNOLOGY_SHARE_TREND_DIMENSIONS[dimension],
    ),
    additionalAttributes: READER_ATTRIBUTES,
  });
  appendTechnologyShareTrendReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    dimensions,
    interval: input.configuration.interval,
    limit: input.configuration.limit,
  });
  const controlFields = Object.keys(source.qualification.controls.slots).map(
    (name) => ({ name, slot: name }),
  );
  source.builder.output(
    TECHNOLOGY_SHARE_TREND_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    controlFields,
  );
  return {
    plan: source.builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: TECHNOLOGY_SHARE_TREND_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: outputIds(dimensions),
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
