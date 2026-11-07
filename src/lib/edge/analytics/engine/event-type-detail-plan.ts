import type { CalendarGranularity } from "@/lib/edge/analytics/contract/types";
import type {
  AdvancedCountQualificationPlanInput,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  addEventContextQualifiedPages,
  appendEventContextCardOutputs,
  EVENT_CONTEXT_REPORT_OUTPUT,
  requiredOwnerAttributes,
} from "@/lib/edge/analytics/engine/event-context-report-plan";
import {
  addEventQualificationControlOutput,
  buildEventQualifiedSource,
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
  type EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  EVENT_REPORT_BASE_ATTRIBUTES,
  EVENT_REPORT_TREND_ATTRIBUTES,
} from "@/lib/edge/analytics/engine/event-source-plan";
import {
  appendEventTypeTrendPoints,
  EVENT_TREND_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import {
  appendEventTypeOverviewOutputs,
  EVENT_TYPE_OVERVIEW_ATTRIBUTES,
  EVENT_TYPE_OVERVIEW_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-overview-plan";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  EVENT_CONTEXT_CARDS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";

const STRING = { kind: "scalar", scalar: "string" } as const;

export const EVENT_TYPE_DETAIL_CONTEXT_LIMIT = 100;

export interface EventTypeDetailQualificationInput {
  readonly siteId: string;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventName: string;
  readonly interval: CalendarGranularity;
  readonly includeBreakdowns: boolean;
  readonly includeContext: boolean;
  readonly contextLimit?: number;
  readonly selectedKeys?: readonly EventContextCardKey[];
}

function matchingEventName(
  builder: ReturnType<typeof createAdvancedCountQualificationBuilder>,
  events: LogicalRelationHandle,
  eventName: string,
): LogicalRelationHandle {
  return builder.filter(
    events,
    builder.compare(
      "eq",
      builder.normalizeString(
        builder.coalesce(
          builder.slot(events, "attribute:event.report.eventName"),
          builder.literal("", STRING),
        ),
        "trim-ascii-space",
      ),
      builder.literal(eventName, STRING),
    ),
  );
}

/** Builds Overview, Type Trend, and optional Context from one Count match set. */
export function buildEventTypeDetailQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(
  input: EventTypeDetailQualificationInput & { readonly count: Count },
): EventQualificationPlan<Count["scope"]> {
  if (
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId
  )
    throw new Error("event_qualification_site_subject_mismatch");

  const selectedSet = new Set(
    input.includeContext ? (input.selectedKeys ?? EVENT_CONTEXT_CARD_KEYS) : [],
  );
  const selected = EVENT_CONTEXT_CARD_KEYS.filter((key) =>
    selectedSet.has(key),
  );
  const attributes = [
    ...new Set([
      ...EVENT_REPORT_BASE_ATTRIBUTES,
      ...EVENT_REPORT_TREND_ATTRIBUTES,
      ...(input.includeBreakdowns
        ? Object.values(EVENT_TYPE_OVERVIEW_ATTRIBUTES)
        : []),
      ...(input.includeContext ? requiredOwnerAttributes(selected) : []),
    ]),
  ];
  const qualified = buildEventQualifiedSource({
    siteId: input.siteId,
    count: input.count,
    purpose: "event-context",
    reportAttributes: attributes,
  });
  const builder = qualified.builder;
  const qualification = qualified.qualification;
  const qualifiedEvents = qualified.events;
  const overviewEvents = matchingEventName(
    builder,
    qualifiedEvents,
    input.eventName,
  );
  const legacyEventNameEvents = input.eventName
    ? matchingEventName(builder, qualifiedEvents, input.eventName)
    : qualifiedEvents;

  appendEventTypeOverviewOutputs({
    builder,
    summaryEvents: overviewEvents,
    denominatorEvents: qualifiedEvents,
    includeBreakdowns: input.includeBreakdowns,
  });
  appendEventTypeTrendPoints({
    builder,
    events: legacyEventNameEvents,
    interval: input.interval,
  });

  const reportSourceRelations: EventQualificationReportSource[] = [
    ...qualified.reportSourceRelations,
  ];
  if (selected.length > 0) {
    const needsBoundaryPages = selected.some(
      (key) => EVENT_CONTEXT_CARDS[key].kind === "session-boundary",
    );
    const qualifiedPages = needsBoundaryPages
      ? addEventContextQualifiedPages({
          builder,
          siteId: input.siteId,
          scope: input.count.scope,
          matches: qualification.matches,
        })
      : undefined;
    if (qualifiedPages)
      reportSourceRelations.push({
        relationId: qualifiedPages.source.id,
        entity: "page",
      });
    appendEventContextCardOutputs({
      builder,
      events: legacyEventNameEvents,
      ...(qualifiedPages ? { pages: qualifiedPages.pages } : {}),
      selected,
      limit: input.contextLimit ?? EVENT_TYPE_DETAIL_CONTEXT_LIMIT,
    });
  }

  addEventQualificationControlOutput(builder, qualification.controls);
  const reportOutputIds = [
    EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
    ...(input.includeBreakdowns
      ? [
          EVENT_TYPE_OVERVIEW_OUTPUTS.page,
          EVENT_TYPE_OVERVIEW_OUTPUTS.country,
          EVENT_TYPE_OVERVIEW_OUTPUTS.device,
          EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
        ]
      : []),
    EVENT_TREND_OUTPUTS.typePoints,
    ...(selected.length > 0 ? [EVENT_CONTEXT_REPORT_OUTPUT] : []),
  ];
  const plan: ValidatedLogicalPlan = builder.finish();
  return {
    plan,
    primaryReportSourceRelationId: qualified.eventSourceRelationId,
    eventSourceRelationId: qualified.eventSourceRelationId,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze(reportOutputIds),
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    ...(qualification.candidateGrain
      ? { candidateGrain: qualification.candidateGrain }
      : {}),
    ...(qualification.additionalGroupedSummaries
      ? {
          additionalGroupedSummaryRelationIds:
            qualification.additionalGroupedSummaries.map(({ id }) => id),
        }
      : {}),
    reportSourceRelations: Object.freeze(reportSourceRelations),
  };
}
