import type { EventPayloadReportSource } from "@/lib/edge/analytics/engine/event-payload-report-source";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { EventPayloadValueTypeCode } from "@/lib/edge/analytics/engine/semantic/event-payload-value-type";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_FIELD_VALUES_OUTPUT = "event-field-values";
export const EVENT_FIELD_VALUES_PAGE_OUTPUT = "event-field-values-page";

const VALUES_OUTPUT = [
  { name: "valueType", slot: "valueType" },
  { name: "events", slot: "events" },
  { name: "occurrences", slot: "occurrences" },
  { name: "firstSeenAt", slot: "firstSeenAt" },
  { name: "lastSeenAt", slot: "lastSeenAt" },
  { name: "stringValue", slot: "stringValue" },
  { name: "numberValue", slot: "numberValue" },
  { name: "booleanValue", slot: "booleanValue" },
] as const;

const PAGE_OUTPUT = [
  ...VALUES_OUTPUT,
  { name: "valueString", slot: "valueString" },
  { name: "valueNumber", slot: "valueNumber" },
  { name: "valueBoolean", slot: "valueBoolean" },
] as const;
export const EVENT_FIELD_VALUES_PAGE_FIELDS = PAGE_OUTPUT.map(
  ({ name }) => name,
);

const SQLITE_NULL_NUMBER = -9223372036854775808;

export interface EventFieldValueCursorValue {
  readonly events: number;
  readonly occurrences: number;
  readonly stringValue: string;
  readonly numberValue: number;
  readonly booleanValue: number;
}

interface EventFieldValuesInput {
  readonly fieldPath: string;
  readonly valueTypeCode: EventPayloadValueTypeCode;
  readonly search?: string;
}

interface EventFieldValuesPlanInput extends EventFieldValuesInput {
  readonly source: EventPayloadReportSource;
  readonly limit: number;
}

export interface EventFieldValuesPageOptions extends EventFieldValuesInput {
  readonly limit: number;
  readonly cursor?: EventFieldValueCursorValue | null;
}

function expression(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(relation, name);
}

function literalComparison(
  builder: LogicalPlanBuilder,
  operator: "eq" | "gt" | "lt",
  input: LogicalExpressionHandle,
  value: string | number,
): LogicalExpressionHandle {
  return builder.compare(
    operator,
    input,
    builder.literal(value, typeof value === "string" ? STRING : NUMBER),
  );
}

function searchedValue(
  builder: LogicalPlanBuilder,
  occurrences: LogicalRelationHandle,
  typeCode: EventPayloadValueTypeCode,
): LogicalExpressionHandle {
  if (typeCode === 1) return expression(builder, occurrences, "stringValue");
  if (typeCode === 2)
    return builder.reportNumberText(
      expression(builder, occurrences, "numberValue"),
      "legacy-report-number-v1",
    );
  if (typeCode === 3) {
    const booleanValue = expression(builder, occurrences, "booleanValue");
    return builder.caseWhen(
      [
        {
          when: literalComparison(builder, "eq", booleanValue, 1),
          then: builder.literal("true", STRING),
        },
      ],
      builder.literal("false", STRING),
    );
  }
  return builder.literal("", STRING);
}

function aggregateValues(
  input: EventFieldValuesInput & {
    readonly source: EventPayloadReportSource;
  },
): LogicalRelationHandle {
  const { builder, occurrences } = input.source;
  const pathAndType = builder.and(
    literalComparison(
      builder,
      "eq",
      expression(builder, occurrences, "path"),
      input.fieldPath,
    ),
    literalComparison(
      builder,
      "eq",
      expression(builder, occurrences, "valueType"),
      input.valueTypeCode,
    ),
  );
  const normalizedSearch = input.search?.trim().toLowerCase();
  const filtered = builder.filter(
    occurrences,
    normalizedSearch
      ? builder.and(
          pathAndType,
          builder.stringMatch(
            "contains",
            builder.normalizeString(
              searchedValue(builder, occurrences, input.valueTypeCode),
              "trim-ascii-space",
            ),
            normalizedSearch,
            false,
            undefined,
            "legacy-report-search-v1",
          ),
        )
      : pathAndType,
  );
  return builder.aggregate(
    filtered,
    {
      valueType: expression(builder, filtered, "valueType"),
      stringValue: expression(builder, filtered, "stringValue"),
      numberValue: expression(builder, filtered, "numberValue"),
      booleanValue: expression(builder, filtered, "booleanValue"),
    },
    [
      {
        name: "events",
        kind: "count-distinct",
        expression: expression(builder, filtered, "eventIdentity"),
      },
      { name: "occurrences", kind: "count-rows" },
      {
        name: "firstSeenAt",
        kind: "min",
        expression: expression(builder, filtered, "occurredAt"),
      },
      {
        name: "lastSeenAt",
        kind: "max",
        expression: expression(builder, filtered, "occurredAt"),
      },
    ],
  );
}

export function buildEventFieldValuesPlan(
  input: EventFieldValuesPlanInput & { readonly limit: number },
): ValidatedLogicalPlan {
  const { builder } = input.source;
  const grouped = aggregateValues(input);
  const sorted = builder.sort(grouped, [
    { slot: "occurrences", direction: "desc", nulls: "last" },
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "stringValue", direction: "asc", nulls: "first" },
    { slot: "numberValue", direction: "asc", nulls: "first" },
    { slot: "booleanValue", direction: "asc", nulls: "first" },
  ]);
  const limited =
    Number.isInteger(input.limit) && input.limit < 0
      ? sorted
      : builder.limit(sorted, input.limit);
  builder.output(EVENT_FIELD_VALUES_OUTPUT, limited, VALUES_OUTPUT);
  return builder.finish();
}

function afterCursor(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  cursor: EventFieldValueCursorValue,
): LogicalExpressionHandle {
  const occurrences = expression(builder, relation, "occurrences");
  const events = expression(builder, relation, "events");
  const valueString = expression(builder, relation, "valueString");
  const valueNumber = expression(builder, relation, "valueNumber");
  const valueBoolean = expression(builder, relation, "valueBoolean");
  const sameOccurrences = literalComparison(
    builder,
    "eq",
    occurrences,
    cursor.occurrences,
  );
  const sameEvents = literalComparison(builder, "eq", events, cursor.events);
  const sameString = literalComparison(
    builder,
    "eq",
    valueString,
    cursor.stringValue,
  );
  const sameNumber = literalComparison(
    builder,
    "eq",
    valueNumber,
    cursor.numberValue,
  );
  return builder.or(
    literalComparison(builder, "lt", occurrences, cursor.occurrences),
    builder.and(
      sameOccurrences,
      literalComparison(builder, "lt", events, cursor.events),
    ),
    builder.and(
      sameOccurrences,
      sameEvents,
      literalComparison(builder, "gt", valueString, cursor.stringValue),
    ),
    builder.and(
      sameOccurrences,
      sameEvents,
      sameString,
      literalComparison(builder, "gt", valueNumber, cursor.numberValue),
    ),
    builder.and(
      sameOccurrences,
      sameEvents,
      sameString,
      sameNumber,
      literalComparison(builder, "gt", valueBoolean, cursor.booleanValue),
    ),
  );
}

export function buildEventFieldValuesPagePlan(
  input: EventFieldValuesPlanInput,
): ValidatedLogicalPlan {
  const { builder } = input.source;
  appendEventFieldValuesPage(builder, input.source.occurrences, input);
  return builder.finish();
}

/** Appends the existing values page output to an already-qualified builder. */
export function appendEventFieldValuesPage(
  builder: LogicalPlanBuilder,
  occurrences: LogicalRelationHandle,
  input: EventFieldValuesPageOptions,
): LogicalRelationHandle {
  const grouped = aggregateValues({
    source: { builder, occurrences },
    fieldPath: input.fieldPath,
    valueTypeCode: input.valueTypeCode,
    ...(input.search !== undefined ? { search: input.search } : {}),
  });
  const valueString = builder.coalesce(
    expression(builder, grouped, "stringValue"),
    builder.literal("", STRING),
  );
  const valueNumber = builder.coalesce(
    expression(builder, grouped, "numberValue"),
    builder.literal(SQLITE_NULL_NUMBER, NUMBER),
  );
  const valueBoolean = builder.coalesce(
    expression(builder, grouped, "booleanValue"),
    builder.literal(-1, NUMBER),
  );
  const projected = builder.project(grouped, {
    valueType: expression(builder, grouped, "valueType"),
    events: expression(builder, grouped, "events"),
    occurrences: expression(builder, grouped, "occurrences"),
    firstSeenAt: expression(builder, grouped, "firstSeenAt"),
    lastSeenAt: expression(builder, grouped, "lastSeenAt"),
    stringValue: expression(builder, grouped, "stringValue"),
    numberValue: expression(builder, grouped, "numberValue"),
    booleanValue: expression(builder, grouped, "booleanValue"),
    valueString,
    valueNumber,
    valueBoolean,
  });
  const after = input.cursor
    ? builder.filter(projected, afterCursor(builder, projected, input.cursor))
    : projected;
  const sorted = builder.sort(after, [
    { slot: "occurrences", direction: "desc", nulls: "last" },
    { slot: "events", direction: "desc", nulls: "last" },
    { slot: "valueString", direction: "asc", nulls: "first" },
    { slot: "valueNumber", direction: "asc", nulls: "first" },
    { slot: "valueBoolean", direction: "asc", nulls: "first" },
  ]);
  const limited = builder.limit(sorted, input.limit + 1);
  builder.output(EVENT_FIELD_VALUES_PAGE_OUTPUT, limited, PAGE_OUTPUT);
  return limited;
}
