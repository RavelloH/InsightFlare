import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  addEventQualificationControlOutput,
  buildEventQualifiedSource,
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventReportSource,
  EVENT_REPORT_BASE_ATTRIBUTES,
  nonEmptyDistinctValue,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_SUMMARY_CARD_OUTPUTS = {
  summary: "event-summary-cards-summary",
  event: "event-summary-cards-event",
  path: "event-summary-cards-path",
  title: "event-summary-cards-title",
  hostname: "event-summary-cards-hostname",
} as const;

export const EVENT_SUMMARY_QUALIFICATION_CONTROL_OUTPUT =
  EVENT_QUALIFICATION_CONTROL_OUTPUT;

export type EventSummaryQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> = EventQualificationPlan<Scope>;

const CARD_FIELDS = [
  { name: "cardType", slot: "cardType" },
  { name: "value", slot: "value" },
  { name: "views", slot: "views" },
  { name: "eventTypes", slot: "eventTypes" },
  { name: "sessions", slot: "sessions" },
  { name: "visitors", slot: "visitors" },
] as const;

function attribute(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function addCardOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  outputId: string,
): void {
  builder.output(outputId, relation, CARD_FIELDS);
}

/** Builds all Event summary cards from one shared Event Source. */
export function buildEventSummaryCardsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
}): ValidatedLogicalPlan {
  const { builder, events } = buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    attributes: [
      ...EVENT_REPORT_BASE_ATTRIBUTES,
      "event.report.ownerPathname",
      "event.report.ownerTitle",
      "event.report.ownerHostname",
    ],
  });

  addEventSummaryCardOutputs(builder, events);
  return builder.finish();
}

/** Builds summary/cards and Count qualification under one subject/time builder. */
export function buildEventSummaryCardsQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly siteId: string;
  readonly count: Count;
}): EventSummaryQualificationPlan<Count["scope"]> {
  const qualified = buildEventQualifiedSource({
    siteId: input.siteId,
    count: input.count,
    purpose: "summary-cards",
  });
  addEventSummaryCardOutputs(qualified.builder, qualified.events);
  addEventQualificationControlOutput(
    qualified.builder,
    qualified.qualification.controls,
  );
  return {
    plan: qualified.builder.finish(),
    primaryReportSourceRelationId: qualified.eventSourceRelationId,
    eventSourceRelationId: qualified.eventSourceRelationId,
    reportSourceRelations: qualified.reportSourceRelations,
    matchesRelationId: qualified.qualification.matches.id,
    controlsRelationId: qualified.qualification.controls.id,
    groupedSummaryRelationId: qualified.qualification.groupedSummary.id,
    ...(qualified.qualification.additionalGroupedSummaries
      ? {
          additionalGroupedSummaryRelationIds:
            qualified.qualification.additionalGroupedSummaries.map(
              ({ id }) => id,
            ),
        }
      : {}),
    controlOutputId: EVENT_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze(Object.values(EVENT_SUMMARY_CARD_OUTPUTS)),
    numericCompatibilityFields:
      qualified.qualification.numericCompatibilityFields,
    scope: qualified.qualification.scope,
    ...(qualified.qualification.candidateGrain
      ? { candidateGrain: qualified.qualification.candidateGrain }
      : {}),
  };
}

function addEventSummaryCardOutputs(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
): void {
  const summary = builder.aggregate(events, {}, [
    { name: "views", kind: "count-rows" },
    {
      name: "eventTypes",
      kind: "count-distinct",
      expression: attribute(builder, events, "eventName"),
    },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        attribute(builder, events, "ownerSessionId"),
      ),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        attribute(builder, events, "ownerVisitorId"),
      ),
    },
  ]);
  const summaryRow = builder.project(summary, {
    cardType: builder.literal("__summary__", STRING),
    value: builder.literal(null, STRING),
    views: builder.slot(summary, "views"),
    eventTypes: builder.slot(summary, "eventTypes"),
    sessions: builder.slot(summary, "sessions"),
    visitors: builder.slot(summary, "visitors"),
  });
  addCardOutput(builder, summaryRow, EVENT_SUMMARY_CARD_OUTPUTS.summary);

  const dimensions = [
    {
      cardType: "event",
      attribute: "eventName",
      outputId: EVENT_SUMMARY_CARD_OUTPUTS.event,
    },
    {
      cardType: "path",
      attribute: "ownerPathname",
      outputId: EVENT_SUMMARY_CARD_OUTPUTS.path,
    },
    {
      cardType: "title",
      attribute: "ownerTitle",
      outputId: EVENT_SUMMARY_CARD_OUTPUTS.title,
    },
    {
      cardType: "hostname",
      attribute: "ownerHostname",
      outputId: EVENT_SUMMARY_CARD_OUTPUTS.hostname,
    },
  ] as const;

  for (const dimension of dimensions) {
    const rawValue = attribute(builder, events, dimension.attribute);
    const nonblank = builder.compare(
      "neq",
      builder.coalesce(rawValue, builder.literal("", STRING)),
      builder.literal("", STRING),
      "trim-ascii-space",
    );
    const filtered = builder.filter(events, nonblank);
    const grouped = builder.aggregate(filtered, { value: rawValue }, [
      { name: "views", kind: "count-rows" },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: nonEmptyDistinctValue(
          builder,
          attribute(builder, filtered, "ownerSessionId"),
        ),
      },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: nonEmptyDistinctValue(
          builder,
          attribute(builder, filtered, "ownerVisitorId"),
        ),
      },
    ]);
    const cardRows = builder.project(grouped, {
      cardType: builder.literal(dimension.cardType, STRING),
      value: builder.slot(grouped, "value"),
      views: builder.slot(grouped, "views"),
      eventTypes: builder.literal(0, NUMBER),
      sessions: builder.slot(grouped, "sessions"),
      visitors: builder.slot(grouped, "visitors"),
    });
    const sorted = builder.sort(cardRows, [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "sessions", direction: "desc", nulls: "last" },
      { slot: "visitors", direction: "desc", nulls: "last" },
      { slot: "value", direction: "asc", nulls: "first" },
    ]);
    const limited = builder.limit(sorted, 100);
    addCardOutput(builder, limited, dimension.outputId);
  }
}
