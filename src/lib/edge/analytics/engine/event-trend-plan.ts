import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type {
  AdvancedCountFilterMatchPlanInput,
  AdvancedCountQualificationPlanInput,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  addEventQualificationControlOutput,
  buildEventQualifiedSource,
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventReportSource,
  EVENT_REPORT_TREND_ATTRIBUTES,
  nonEmptyDistinctValue,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { type LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_TREND_OUTPUTS = {
  series: "event-trend-series",
  points: "event-trend-points",
  other: "event-trend-other",
  typePoints: "event-type-trend-points",
} as const;

export interface EventTrendPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly eventName?: string;
}

function attribute(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function eventTrendSource(input: EventTrendPlanInput) {
  return buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    attributes: EVENT_REPORT_TREND_ATTRIBUTES,
    ...(input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics: "legacy-truthy-raw" as const,
        }
      : {}),
  });
}

function addOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  id: string,
  fields: readonly { readonly name: string; readonly slot: string }[],
): void {
  builder.output(id, relation, fields);
}

function eventTrendSeriesAggregate(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.aggregate(
    events,
    { eventName: attribute(builder, events, "eventName") },
    [
      { name: "events", kind: "count-rows" },
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
    ],
  );
}

export function buildEventTrendSeriesPlan(
  input: EventTrendPlanInput & { readonly limit: number },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
  const series = eventTrendSeriesAggregate(builder, events);
  const sorted = builder.sort(series, [
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "eventName", direction: "asc", nulls: "last" },
  ]);
  const limited = builder.limit(sorted, input.limit);
  addOutput(builder, limited, EVENT_TREND_OUTPUTS.series, [
    { name: "eventName", slot: "eventName" },
    { name: "events", slot: "events" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

export function buildEventTrendPointsPlan(
  input: EventTrendPlanInput & {
    readonly interval: CalendarGranularity;
    readonly seriesNames: readonly string[];
    readonly otherToken: string;
  },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
  const eventName = attribute(builder, events, "eventName");
  const bucketed = builder.project(events, {
    eventName,
    bucket: builder.timeBucket(
      attribute(builder, events, "occurredAt"),
      input.interval,
    ),
  });
  const bucketEventName = builder.slot(bucketed, "eventName");
  const seriesName =
    input.seriesNames.length > 0
      ? builder.caseWhen(
          [
            {
              when: builder.in(
                bucketEventName,
                input.seriesNames.map((name) => builder.literal(name, STRING)),
              ),
              then: bucketEventName,
            },
          ],
          builder.literal(input.otherToken, STRING),
        )
      : builder.literal(input.otherToken, STRING);
  const grouped = builder.aggregate(
    bucketed,
    { bucket: builder.slot(bucketed, "bucket"), seriesName },
    [{ name: "events", kind: "count-rows" }],
  );
  const inRange = builder.filter(
    grouped,
    builder.isNull(builder.slot(grouped, "bucket"), true),
  );
  const sorted = builder.sort(inRange, [
    { slot: "bucket", direction: "asc", nulls: "last" },
  ]);
  addOutput(builder, sorted, EVENT_TREND_OUTPUTS.points, [
    { name: "bucket", slot: "bucket" },
    { name: "seriesName", slot: "seriesName" },
    { name: "events", slot: "events" },
  ]);
  return builder.finish();
}

export function buildEventTrendOtherPlan(
  input: EventTrendPlanInput & {
    readonly seriesNames: readonly string[];
    readonly otherLabel: string;
  },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
  const eventName = attribute(builder, events, "eventName");
  const filtered =
    input.seriesNames.length > 0
      ? builder.filter(
          events,
          builder.in(
            eventName,
            input.seriesNames.map((name) => builder.literal(name, STRING)),
            true,
          ),
        )
      : events;
  const totals = builder.aggregate(filtered, {}, [
    { name: "events", kind: "count-rows" },
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
  const labeled = builder.project(totals, {
    eventName: builder.literal(input.otherLabel, STRING),
    events: builder.slot(totals, "events"),
    sessions: builder.slot(totals, "sessions"),
    visitors: builder.slot(totals, "visitors"),
  });
  addOutput(builder, labeled, EVENT_TREND_OUTPUTS.other, [
    { name: "eventName", slot: "eventName" },
    { name: "events", slot: "events" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

export interface EventTrendQualificationInput<
  Count extends AdvancedCountQualificationPlanInput =
    AdvancedCountFilterMatchPlanInput,
> extends EventTrendPlanInput {
  readonly count: Count;
  readonly interval: CalendarGranularity;
  readonly limit: number;
  readonly otherToken: string;
  readonly otherLabel: string;
}

/** Builds Count controls and every Event trend output in one Logical graph. */
export function buildEventTrendQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(
  input: EventTrendQualificationInput<Count>,
): EventQualificationPlan<Count["scope"]> {
  const qualified = buildEventQualifiedSource({
    siteId: input.siteId,
    count: input.count,
    purpose: "event-trend",
    ...(input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics: "legacy-truthy-raw" as const,
        }
      : {}),
  });
  const { builder, events } = qualified;
  const normalizedEvents = builder.project(events, {
    eventName: attribute(builder, events, "eventName"),
    ownerSessionId: attribute(builder, events, "ownerSessionId"),
    ownerVisitorId: attribute(builder, events, "ownerVisitorId"),
    occurredAt: attribute(builder, events, "occurredAt"),
  });
  const series = builder.sort(eventTrendSeriesAggregate(builder, events), [
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "eventName", direction: "asc", nulls: "last" },
  ]);
  const topSeries = builder.limit(series, input.limit);
  addOutput(builder, topSeries, EVENT_TREND_OUTPUTS.series, [
    { name: "eventName", slot: "eventName" },
    { name: "events", slot: "events" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);

  const bucketed = builder.project(normalizedEvents, {
    eventName: builder.slot(normalizedEvents, "eventName"),
    bucket: builder.timeBucket(
      builder.slot(normalizedEvents, "occurredAt"),
      input.interval,
    ),
  });
  const inTopSeries = builder.semiJoin(bucketed, topSeries, [
    { left: "eventName", right: "eventName" },
  ]);
  const outsideTopSeries = builder.antiJoin(bucketed, topSeries, [
    { left: "eventName", right: "eventName" },
  ]);
  const topPointsInput = builder.project(inTopSeries, {
    bucket: builder.slot(inTopSeries, "bucket"),
    seriesName: builder.slot(inTopSeries, "eventName"),
  });
  const topPoints = builder.aggregate(
    topPointsInput,
    {
      bucket: builder.slot(topPointsInput, "bucket"),
      seriesName: builder.slot(topPointsInput, "seriesName"),
    },
    [{ name: "events", kind: "count-rows" }],
  );
  const otherPointsInput = builder.project(outsideTopSeries, {
    bucket: builder.slot(outsideTopSeries, "bucket"),
    seriesName: builder.literal(input.otherToken, STRING),
  });
  const otherPoints = builder.aggregate(
    otherPointsInput,
    {
      bucket: builder.slot(otherPointsInput, "bucket"),
      seriesName: builder.slot(otherPointsInput, "seriesName"),
    },
    [{ name: "events", kind: "count-rows" }],
  );
  const allPointRows = builder.appendRows(
    [topPoints, otherPoints],
    ["bucket", "seriesName", "events"],
  );
  const points = builder.aggregate(
    allPointRows,
    {
      bucket: builder.slot(allPointRows, "bucket"),
      seriesName: builder.slot(allPointRows, "seriesName"),
    },
    [
      {
        name: "events",
        kind: "sum",
        expression: builder.slot(allPointRows, "events"),
      },
    ],
  );
  const inRange = builder.filter(
    points,
    builder.isNull(builder.slot(points, "bucket"), true),
  );
  const sortedPoints = builder.sort(inRange, [
    { slot: "bucket", direction: "asc", nulls: "last" },
  ]);
  addOutput(builder, sortedPoints, EVENT_TREND_OUTPUTS.points, [
    { name: "bucket", slot: "bucket" },
    { name: "seriesName", slot: "seriesName" },
    { name: "events", slot: "events" },
  ]);

  let otherEvents = normalizedEvents;
  if (input.limit > 0) {
    const nullTopSeries = builder.filter(
      topSeries,
      builder.isNull(builder.slot(topSeries, "eventName")),
    );
    const nullTopCount = builder.aggregate(nullTopSeries, {}, [
      { name: "nullTopCount", kind: "count-rows" },
    ]);
    const keyedEvents = builder.project(normalizedEvents, {
      eventName: builder.slot(normalizedEvents, "eventName"),
      ownerSessionId: builder.slot(normalizedEvents, "ownerSessionId"),
      ownerVisitorId: builder.slot(normalizedEvents, "ownerVisitorId"),
      gateKey: builder.literal(1, NUMBER),
    });
    const keyedNullTopCount = builder.project(nullTopCount, {
      gateKey: builder.literal(1, NUMBER),
      nullTopCount: builder.slot(nullTopCount, "nullTopCount"),
    });
    const gatedEvents = builder.join(keyedEvents, keyedNullTopCount, [
      { left: "gateKey", right: "gateKey" },
    ]);
    const noNullTopSeries = builder.filter(
      gatedEvents,
      builder.and(
        builder.compare(
          "eq",
          builder.slot(gatedEvents, "right.nullTopCount"),
          builder.literal(0, NUMBER),
        ),
        builder.isNull(builder.slot(gatedEvents, "eventName"), true),
      ),
    );
    otherEvents = builder.antiJoin(noNullTopSeries, topSeries, [
      { left: "eventName", right: "eventName" },
    ]);
  }
  const otherTotals = builder.aggregate(otherEvents, {}, [
    { name: "events", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        builder.slot(otherEvents, "ownerSessionId"),
      ),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        builder.slot(otherEvents, "ownerVisitorId"),
      ),
    },
  ]);
  const labeledOther = builder.project(otherTotals, {
    eventName: builder.literal(input.otherLabel, STRING),
    events: builder.slot(otherTotals, "events"),
    sessions: builder.slot(otherTotals, "sessions"),
    visitors: builder.slot(otherTotals, "visitors"),
  });
  addOutput(builder, labeledOther, EVENT_TREND_OUTPUTS.other, [
    { name: "eventName", slot: "eventName" },
    { name: "events", slot: "events" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  addEventQualificationControlOutput(builder, qualified.qualification.controls);

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: qualified.eventSourceRelationId,
    eventSourceRelationId: qualified.eventSourceRelationId,
    reportSourceRelations: qualified.reportSourceRelations,
    matchesRelationId: qualified.qualification.matches.id,
    controlsRelationId: qualified.qualification.controls.id,
    groupedSummaryRelationId: qualified.qualification.groupedSummary.id,
    controlOutputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze([
      EVENT_TREND_OUTPUTS.series,
      EVENT_TREND_OUTPUTS.points,
      EVENT_TREND_OUTPUTS.other,
    ]),
    numericCompatibilityFields:
      qualified.qualification.numericCompatibilityFields,
    scope: qualified.qualification.scope,
    ...(qualified.qualification.candidateGrain
      ? { candidateGrain: qualified.qualification.candidateGrain }
      : {}),
    ...(qualified.qualification.additionalGroupedSummaries
      ? {
          additionalGroupedSummaryRelationIds: Object.freeze(
            qualified.qualification.additionalGroupedSummaries.map(
              ({ id }) => id,
            ),
          ),
        }
      : {}),
  };
}

export function appendEventTypeTrendPoints(input: {
  readonly builder: LogicalPlanBuilder;
  readonly events: LogicalRelationHandle;
  readonly interval: CalendarGranularity;
}): void {
  const { builder, events } = input;
  const bucketed = builder.project(events, {
    bucket: builder.timeBucket(
      attribute(builder, events, "occurredAt"),
      input.interval,
    ),
    ownerVisitorId: attribute(builder, events, "ownerVisitorId"),
  });
  const grouped = builder.aggregate(
    bucketed,
    { bucket: builder.slot(bucketed, "bucket") },
    [
      { name: "events", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: nonEmptyDistinctValue(
          builder,
          builder.slot(bucketed, "ownerVisitorId"),
        ),
      },
    ],
  );
  const inRange = builder.filter(
    grouped,
    builder.isNull(builder.slot(grouped, "bucket"), true),
  );
  const sorted = builder.sort(inRange, [
    { slot: "bucket", direction: "asc", nulls: "last" },
  ]);
  addOutput(builder, sorted, EVENT_TREND_OUTPUTS.typePoints, [
    { name: "bucket", slot: "bucket" },
    { name: "events", slot: "events" },
    { name: "visitors", slot: "visitors" },
  ]);
}

export function buildEventTypeTrendPlan(
  input: EventTrendPlanInput & { readonly interval: CalendarGranularity },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
  appendEventTypeTrendPoints({
    builder,
    events,
    interval: input.interval,
  });
  return builder.finish();
}
