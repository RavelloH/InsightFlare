import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { buildEventReportSource } from "@/lib/edge/analytics/engine/event-source-plan";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_FIELDS_OUTPUT = "event-fields";
export const EVENT_FIELDS_PAGE_OUTPUT = "event-fields-page";

export const EVENT_FIELDS = [
  { name: "path", slot: "path" },
  { name: "valueType", slot: "valueType" },
  { name: "events", slot: "events" },
  { name: "occurrences", slot: "occurrences" },
  { name: "firstSeenAt", slot: "firstSeenAt" },
  { name: "lastSeenAt", slot: "lastSeenAt" },
  { name: "stringValue", slot: "stringValue" },
  { name: "numberValue", slot: "numberValue" },
  { name: "booleanValue", slot: "booleanValue" },
] as const;

export interface EventFieldsPlanInput {
  readonly siteId: string;
  /** The actual legacy reader window, which may differ from prepared time. */
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
}

export interface EventFieldCursorValue {
  readonly events: number;
  readonly occurrences: number;
  readonly path: string;
  readonly valueType: number;
}

function expression(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(relation, name);
}

function source(input: EventFieldsPlanInput) {
  return buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.scopePlan
      ? { preparedTimePolicy: "reader-window" as const }
      : {}),
    attributes: ["event.report.eventName", "event.report.internalPk"],
    ...(input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics: "legacy-truthy-raw",
        }
      : {}),
  });
}

function aggregateFields(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
): LogicalRelationHandle {
  const occurrences = builder.eventPayloadOccurrences(events);
  return builder.aggregate(
    occurrences,
    {
      path: expression(builder, occurrences, "path"),
      valueType: expression(builder, occurrences, "valueType"),
    },
    [
      {
        name: "events",
        kind: "count-distinct",
        expression: expression(builder, occurrences, "internalEventKey"),
      },
      { name: "occurrences", kind: "count-rows" },
      {
        name: "firstSeenAt",
        kind: "min",
        expression: expression(builder, occurrences, "occurredAt"),
      },
      {
        name: "lastSeenAt",
        kind: "max",
        expression: expression(builder, occurrences, "occurredAt"),
      },
      {
        name: "stringValue",
        kind: "min",
        expression: expression(builder, occurrences, "stringValue"),
      },
      {
        name: "numberValue",
        kind: "min",
        expression: expression(builder, occurrences, "numberValue"),
      },
      {
        name: "booleanValue",
        kind: "min",
        expression: expression(builder, occurrences, "booleanValue"),
      },
    ],
  );
}

function addOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  outputId: string,
): void {
  builder.output(outputId, relation, EVENT_FIELDS);
}

function compareLiteral(
  builder: LogicalPlanBuilder,
  operator: "eq" | "gt" | "lt",
  left: LogicalExpressionHandle,
  value: string | number,
): LogicalExpressionHandle {
  return builder.compare(
    operator,
    left,
    builder.literal(value, typeof value === "string" ? STRING : NUMBER),
  );
}

function afterCursor(
  builder: LogicalPlanBuilder,
  grouped: LogicalRelationHandle,
  cursor: EventFieldCursorValue,
): LogicalExpressionHandle {
  const events = expression(builder, grouped, "events");
  const occurrences = expression(builder, grouped, "occurrences");
  const path = expression(builder, grouped, "path");
  const valueType = expression(builder, grouped, "valueType");
  const sameEvents = compareLiteral(builder, "eq", events, cursor.events);
  const sameOccurrences = compareLiteral(
    builder,
    "eq",
    occurrences,
    cursor.occurrences,
  );
  const samePath = compareLiteral(builder, "eq", path, cursor.path);
  return builder.or(
    compareLiteral(builder, "lt", events, cursor.events),
    builder.and(
      sameEvents,
      compareLiteral(builder, "lt", occurrences, cursor.occurrences),
    ),
    builder.and(
      sameEvents,
      sameOccurrences,
      compareLiteral(builder, "gt", path, cursor.path),
    ),
    builder.and(
      sameEvents,
      sameOccurrences,
      samePath,
      compareLiteral(builder, "gt", valueType, cursor.valueType),
    ),
  );
}

export function buildEventFieldsPlan(
  input: EventFieldsPlanInput & { readonly limit: number },
): ValidatedLogicalPlan {
  const { builder, events } = source(input);
  const grouped = aggregateFields(builder, events);
  const sorted = builder.sort(grouped, [
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "occurrences", direction: "desc", nulls: "last" },
    { slot: "path", direction: "asc", nulls: "first" },
  ]);
  const limited = input.limit < 0 ? sorted : builder.limit(sorted, input.limit);
  addOutput(builder, limited, EVENT_FIELDS_OUTPUT);
  return builder.finish();
}

export function buildEventFieldsPagePlan(
  input: EventFieldsPlanInput & {
    readonly limit: number;
    readonly cursor?: EventFieldCursorValue | null;
  },
): ValidatedLogicalPlan {
  const { builder, events } = source(input);
  const grouped = aggregateFields(builder, events);
  const after = input.cursor
    ? builder.filter(grouped, afterCursor(builder, grouped, input.cursor))
    : grouped;
  const sorted = builder.sort(after, [
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "occurrences", direction: "desc", nulls: "last" },
    { slot: "path", direction: "asc", nulls: "first" },
    { slot: "valueType", direction: "asc", nulls: "first" },
  ]);
  const limited = builder.limit(sorted, input.limit + 1);
  addOutput(builder, limited, EVENT_FIELDS_PAGE_OUTPUT);
  return builder.finish();
}
