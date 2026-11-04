import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  addEventQualificationControlOutput,
  buildEventQualifiedSource,
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  appendEventRecordPage,
  EVENT_RECORD_ATTRIBUTES,
  EVENT_RECORD_PAGE_OUTPUT_ID,
  type EventRecordPageOptions,
} from "@/lib/edge/analytics/engine/event-record-page-plan";

export type EventRecordPageQualificationPlan = EventQualificationPlan;

/** Builds a records report and Count qualification in one Logical builder. */
export function buildEventRecordPageQualificationPlan(input: {
  readonly siteId: string;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly options: EventRecordPageOptions;
}): EventRecordPageQualificationPlan {
  const qualified = buildEventQualifiedSource({
    siteId: input.siteId,
    count: input.count,
    purpose: "records",
    reportAttributes: EVENT_RECORD_ATTRIBUTES,
    ...(input.options.eventName !== undefined
      ? { eventName: input.options.eventName }
      : {}),
  });
  appendEventRecordPage(qualified.builder, qualified.events, input.options);
  addEventQualificationControlOutput(
    qualified.builder,
    qualified.qualification.controls,
  );
  return {
    plan: qualified.builder.finish(),
    primaryReportSourceRelationId: qualified.eventSourceRelationId,
    eventSourceRelationId: qualified.eventSourceRelationId,
    matchesRelationId: qualified.qualification.matches.id,
    controlsRelationId: qualified.qualification.controls.id,
    groupedSummaryRelationId: qualified.qualification.groupedSummary.id,
    controlOutputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze([EVENT_RECORD_PAGE_OUTPUT_ID]),
    numericCompatibilityFields:
      qualified.qualification.numericCompatibilityFields,
    scope: qualified.qualification.scope,
    reportSourceRelations: qualified.reportSourceRelations,
  };
}
