import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendOverviewChannelsReport,
  OVERVIEW_CHANNELS_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import type {
  AnalyticsQualificationPlan,
  EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const CHANNEL_LIST_QUALIFICATION_CONTROL_OUTPUT =
  "channel-list-qualification-controls";

export type ChannelListQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> = AnalyticsQualificationPlan<Scope> & {
  readonly reportOutputIds: readonly [typeof OVERVIEW_CHANNELS_REPORT_OUTPUT];
};

export function buildChannelListQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: Count;
  readonly eventCandidateReportProjection?: "page-visits";
  readonly limit: number;
  readonly filterMode?: QualifiedSourceFilterMode;
}): ChannelListQualificationPlan<Count["scope"]> {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "channels",
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
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [PAGE_DIMENSION_SELECTIONS.trafficChannel],
  });
  const { builder, qualification, qualifiedPages } = source;
  appendOverviewChannelsReport(builder, qualifiedPages, input.limit);
  builder.output(
    CHANNEL_LIST_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  const reportSourceRelations: readonly EventQualificationReportSource[] =
    source.reportSourceRelations;
  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: CHANNEL_LIST_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [OVERVIEW_CHANNELS_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations,
    ...qualificationPlanMetadata(
      qualification,
      input.eventCandidateReportProjection,
    ),
  };
}
