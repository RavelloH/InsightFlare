import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import {
  buildEventReportSource,
  EVENT_REPORT_TREND_ATTRIBUTES,
  nonEmptyDistinctValue,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { type LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

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

export function buildEventTrendSeriesPlan(
  input: EventTrendPlanInput & { readonly limit: number },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
  const series = builder.aggregate(
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

export function buildEventTypeTrendPlan(
  input: EventTrendPlanInput & { readonly interval: CalendarGranularity },
): ValidatedLogicalPlan {
  const { builder, events } = eventTrendSource(input);
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
  return builder.finish();
}
