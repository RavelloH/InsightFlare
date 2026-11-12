import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  addEventReportSource,
  createEventReportSourceContext,
  EVENT_REPORT_BASE_ATTRIBUTES,
  nonEmptyDistinctValue,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
export const EVENT_TYPE_OVERVIEW_ATTRIBUTES = {
  page: "event.report.ownerPathname",
  country: "event.report.ownerCountry",
  device: "event.report.ownerDeviceType",
  browser: "event.report.ownerBrowser",
} as const;

export const EVENT_TYPE_OVERVIEW_OUTPUTS = {
  summary: "event-type-overview-summary",
  page: "event-type-overview-page",
  country: "event-type-overview-country",
  device: "event-type-overview-device",
  browser: "event-type-overview-browser",
} as const;

export const EVENT_TYPE_OVERVIEW_FIELDS = [
  { name: "cardType", slot: "cardType" },
  { name: "value", slot: "value" },
  { name: "events", slot: "events" },
  { name: "eventTypes", slot: "eventTypes" },
  { name: "sessions", slot: "sessions" },
  { name: "visitors", slot: "visitors" },
  { name: "scopedEvents", slot: "scopedEvents" },
] as const;

function attribute(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function addOverviewOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  outputId: string,
): void {
  builder.output(outputId, relation, EVENT_TYPE_OVERVIEW_FIELDS);
}

/** Appends the overview summary and optional breakdown outputs to a builder. */
export function appendEventTypeOverviewOutputs(input: {
  readonly builder: LogicalPlanBuilder;
  readonly summaryEvents: LogicalRelationHandle;
  readonly denominatorEvents: LogicalRelationHandle;
  readonly includeBreakdowns: boolean;
}): void {
  const { builder, summaryEvents, denominatorEvents } = input;
  const breakdownEvents = input.includeBreakdowns ? summaryEvents : undefined;
  const denominator = builder.aggregate(denominatorEvents, {}, [
    { name: "scopedEvents", kind: "count-rows" },
  ]);

  const summary = builder.aggregate(summaryEvents, {}, [
    { name: "events", kind: "count-rows" },
    {
      name: "eventTypes",
      kind: "count-distinct",
      expression: attribute(builder, summaryEvents, "eventName"),
    },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        attribute(builder, summaryEvents, "ownerSessionId"),
      ),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        attribute(builder, summaryEvents, "ownerVisitorId"),
      ),
    },
  ]);
  const summaryWithDenominator = builder.join(
    summary,
    denominator,
    [],
    "inner",
  );
  const summaryRow = builder.project(summaryWithDenominator, {
    cardType: builder.literal("summary", STRING),
    value: builder.literal(null, STRING),
    events: builder.slot(summaryWithDenominator, "events"),
    eventTypes: builder.slot(summaryWithDenominator, "eventTypes"),
    sessions: builder.slot(summaryWithDenominator, "sessions"),
    visitors: builder.slot(summaryWithDenominator, "visitors"),
    scopedEvents: builder.slot(summaryWithDenominator, "right.scopedEvents"),
  });
  addOverviewOutput(builder, summaryRow, EVENT_TYPE_OVERVIEW_OUTPUTS.summary);

  if (input.includeBreakdowns && breakdownEvents) {
    const dimensions = [
      {
        cardType: "page",
        attribute: "ownerPathname",
        outputId: EVENT_TYPE_OVERVIEW_OUTPUTS.page,
      },
      {
        cardType: "country",
        attribute: "ownerCountry",
        outputId: EVENT_TYPE_OVERVIEW_OUTPUTS.country,
      },
      {
        cardType: "device",
        attribute: "ownerDeviceType",
        outputId: EVENT_TYPE_OVERVIEW_OUTPUTS.device,
      },
      {
        cardType: "browser",
        attribute: "ownerBrowser",
        outputId: EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
      },
    ] as const;

    for (const dimension of dimensions) {
      const rawValue = attribute(builder, breakdownEvents, dimension.attribute);
      const nonblank = builder.compare(
        "neq",
        builder.coalesce(rawValue, builder.literal("", STRING)),
        builder.literal("", STRING),
        "trim-ascii-space",
      );
      const filtered = builder.filter(breakdownEvents, nonblank);
      const grouped = builder.aggregate(filtered, { value: rawValue }, [
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
      const groupedWithDenominator = builder.join(
        grouped,
        denominator,
        [],
        "inner",
      );
      const cardRows = builder.project(groupedWithDenominator, {
        cardType: builder.literal(dimension.cardType, STRING),
        value: builder.slot(groupedWithDenominator, "value"),
        events: builder.slot(groupedWithDenominator, "events"),
        eventTypes: builder.literal(0, NUMBER),
        sessions: builder.slot(groupedWithDenominator, "sessions"),
        visitors: builder.slot(groupedWithDenominator, "visitors"),
        scopedEvents: builder.slot(
          groupedWithDenominator,
          "right.scopedEvents",
        ),
      });
      const sorted = builder.sort(cardRows, [
        { slot: "events", direction: "desc", nulls: "last" },
        { slot: "sessions", direction: "desc", nulls: "last" },
        { slot: "value", direction: "asc", nulls: "first" },
      ]);
      const limited = builder.limit(sorted, 8);
      addOverviewOutput(builder, limited, dimension.outputId);
    }
  }
}

/** Builds one Event type overview plan, including its independent denominator. */
export function buildEventTypeOverviewPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly eventName: string;
  readonly includeBreakdowns?: boolean;
  readonly denominatorSource: "event-report" | "raw-event-domain";
}): ValidatedLogicalPlan {
  const includeBreakdowns = input.includeBreakdowns !== false;
  const context = createEventReportSourceContext({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
  });
  const builder = context.builder;
  const summaryEvents = addEventReportSource(context, {
    attributes: includeBreakdowns
      ? [
          ...EVENT_REPORT_BASE_ATTRIBUTES,
          ...Object.values(EVENT_TYPE_OVERVIEW_ATTRIBUTES),
        ]
      : EVENT_REPORT_BASE_ATTRIBUTES,
    eventName: input.eventName,
    eventNameInputSemantics: "defined-raw-value",
  });
  const denominatorEvents =
    input.denominatorSource === "raw-event-domain"
      ? builder.source("event", { temporalDomain: "candidate" })
      : addEventReportSource(context, { attributes: [] });
  appendEventTypeOverviewOutputs({
    builder,
    summaryEvents,
    denominatorEvents,
    includeBreakdowns,
  });
  return builder.finish();
}
