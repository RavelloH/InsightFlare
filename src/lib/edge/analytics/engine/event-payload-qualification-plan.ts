import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  type AdvancedCountFilterMatchPlanInput,
  appendAdvancedCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { appendEventPayloadOccurrences } from "@/lib/edge/analytics/engine/event-payload-report-source";
import {
  addEventQualificationControlOutput,
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { EVENT_REPORT_BASE_ATTRIBUTES } from "@/lib/edge/analytics/engine/event-source-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

export type EventPayloadQualificationPlan<
  TReportOutputIds extends readonly string[],
> = Omit<EventQualificationPlan, "plan" | "reportOutputIds"> & {
  readonly plan: ValidatedLogicalPlan;
  readonly reportOutputIds: TReportOutputIds;
};

/** Builds the shared Count-to-payload identity path, then appends one report. */
export function buildEventPayloadQualificationPlan<
  TReportOutputIds extends readonly [string, ...string[]],
>(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly eventName?: string;
  readonly contextMismatchCode?: string;
  readonly appendReport: (
    builder: LogicalPlanBuilder,
    occurrences: LogicalRelationHandle,
  ) => TReportOutputIds;
}): EventPayloadQualificationPlan<TReportOutputIds> {
  const queryReadRange = input.queryTime.readRange ?? input.queryTime.range;
  if (
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId ||
    input.queryTime.range.startMs !== input.count.candidateRange.startMs ||
    input.queryTime.range.endExclusiveMs !==
      input.count.candidateRange.endExclusiveMs ||
    queryReadRange.startMs !== input.count.readRange.startMs ||
    queryReadRange.endExclusiveMs !== input.count.readRange.endExclusiveMs ||
    input.queryTime.filterRange !== undefined ||
    input.queryTime.filterRangeEmpty === true ||
    input.queryTime.fullHistory === true ||
    input.queryTime.reportingTimeZone !== input.count.reportingTimeZone ||
    input.queryTime.capturedAtMs !== input.count.capturedAtMs ||
    input.scopePlan.scope !== input.count.scope
  )
    throw new Error(
      input.contextMismatchCode ??
        "event_payload_qualification_request_context_mismatch",
    );

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification = appendAdvancedCountQualification(builder, input.count);
  const source = builder.source("event", {
    temporalDomain: "read",
    attributes: EVENT_REPORT_BASE_ATTRIBUTES,
  });
  // Keep Count's site-qualified entity IDs as the admission side while the
  // raw Event source remains the identity carrier for payload joins.
  const siteMatches = builder.filter(
    qualification.matches,
    builder.compare(
      "eq",
      builder.slot(qualification.matches, "siteId"),
      builder.literal(input.siteId, STRING),
    ),
  );
  const ownerAttribute =
    qualification.scope === "session"
      ? "attribute:event.report.ownerSessionId"
      : "attribute:event.report.ownerVisitorId";
  const ownerQualifiedEvents = builder.semiJoin(source, siteMatches, [
    { left: ownerAttribute, right: "entityId" },
  ]);
  const qualifiedEvents = input.eventName
    ? builder.filter(
        ownerQualifiedEvents,
        builder.compare(
          "eq",
          builder.normalizeString(
            builder.coalesce(
              builder.slot(
                ownerQualifiedEvents,
                "attribute:event.report.eventName",
              ),
              builder.literal("", STRING),
            ),
            "trim-ascii-space",
          ),
          builder.literal(input.eventName, STRING),
        ),
      )
    : ownerQualifiedEvents;
  const occurrences = appendEventPayloadOccurrences(builder, qualifiedEvents);
  const reportOutputIds = input.appendReport(builder, occurrences);
  addEventQualificationControlOutput(builder, qualification.controls);

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.id,
    eventSourceRelationId: source.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds,
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: [{ relationId: source.id, entity: "event" }],
  };
}
