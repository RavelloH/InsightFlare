import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  buildEventReportSource,
  EVENT_REPORT_BASE_ATTRIBUTES,
  nonEmptyDistinctValue,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { type LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_TYPE_SUMMARY_OUTPUTS = {
  list: "event-type-list",
  page: "event-type-page",
  summary: "event-summary-metrics",
} as const;

export interface EventTypeSummaryCursor {
  readonly views: number;
  readonly sessions: number;
  readonly value: string;
}

export type EventTypeSummaryQuery =
  | { readonly kind: "list"; readonly limit: number; readonly search?: string }
  | {
      readonly kind: "page";
      readonly limit: number;
      readonly search?: string;
      readonly cursor?: EventTypeSummaryCursor | null;
    }
  | { readonly kind: "summary" };

function eventAttribute(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function eventSummarySource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
}) {
  return buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    attributes: EVENT_REPORT_BASE_ATTRIBUTES,
  });
}

function eventRollup(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
): LogicalRelationHandle {
  const eventName = eventAttribute(builder, events, "eventName");
  const groupValue = builder.coalesce(eventName, builder.literal("", STRING));
  return builder.aggregate(events, { value: groupValue }, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        eventAttribute(builder, events, "ownerSessionId"),
      ),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonEmptyDistinctValue(
        builder,
        eventAttribute(builder, events, "ownerVisitorId"),
      ),
    },
  ]);
}

function eventValueFilter(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  search: string | undefined,
  applySearch: boolean,
): LogicalRelationHandle {
  let filtered = builder.filter(
    input,
    builder.compare(
      "neq",
      builder.slot(input, "value"),
      builder.literal("", STRING),
      "trim-ascii-space",
    ),
  );
  if (applySearch && search) {
    filtered = builder.filter(
      filtered,
      builder.stringMatch(
        "contains",
        builder.slot(filtered, "value"),
        search.trim().toLowerCase(),
        false,
        undefined,
        "legacy-record-search-v1",
      ),
    );
  }
  return filtered;
}

function applyEventTypeCursor(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  cursor: EventTypeSummaryCursor,
): LogicalRelationHandle {
  const views = builder.slot(input, "views");
  const sessions = builder.slot(input, "sessions");
  const value = builder.slot(input, "value");
  return builder.filter(
    input,
    builder.or(
      builder.compare("lt", views, builder.literal(cursor.views, NUMBER)),
      builder.and(
        builder.compare("eq", views, builder.literal(cursor.views, NUMBER)),
        builder.compare(
          "lt",
          sessions,
          builder.literal(cursor.sessions, NUMBER),
        ),
      ),
      builder.and(
        builder.compare("eq", views, builder.literal(cursor.views, NUMBER)),
        builder.compare(
          "eq",
          sessions,
          builder.literal(cursor.sessions, NUMBER),
        ),
        builder.compare("gt", value, builder.literal(cursor.value, STRING)),
      ),
    ),
  );
}

function addEventTypeOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  outputId: string,
): void {
  builder.output(outputId, relation, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

/** Builds one validated Logical query for an Event type list, page, or summary. */
export function buildEventTypeSummaryPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly query: EventTypeSummaryQuery;
}): ValidatedLogicalPlan {
  const { builder, events } = eventSummarySource(input);

  if (input.query.kind === "summary") {
    const eventName = eventAttribute(builder, events, "eventName");
    const summary = builder.aggregate(events, {}, [
      { name: "events", kind: "count-rows" },
      {
        name: "eventTypes",
        kind: "count-distinct",
        expression: eventName,
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: nonEmptyDistinctValue(
          builder,
          eventAttribute(builder, events, "ownerSessionId"),
        ),
      },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: nonEmptyDistinctValue(
          builder,
          eventAttribute(builder, events, "ownerVisitorId"),
        ),
      },
    ]);
    builder.output(EVENT_TYPE_SUMMARY_OUTPUTS.summary, summary, [
      { name: "events", slot: "events" },
      { name: "eventTypes", slot: "eventTypes" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ]);
    return builder.finish();
  }

  let rows = eventValueFilter(
    builder,
    eventRollup(builder, events),
    input.query.search,
    input.query.kind === "list"
      ? Boolean(input.query.search)
      : Boolean(input.query.search?.trim()),
  );
  if (input.query.kind === "page" && input.query.cursor) {
    rows = applyEventTypeCursor(builder, rows, input.query.cursor);
  }
  rows = builder.sort(rows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "value", direction: "asc", nulls: "last" },
  ]);
  const limit = input.query.limit;
  if (input.query.kind === "page") {
    rows = builder.limit(rows, limit + 1);
  } else if (limit > 0) {
    rows = builder.limit(rows, limit);
  }
  addEventTypeOutput(
    builder,
    rows,
    input.query.kind === "list"
      ? EVENT_TYPE_SUMMARY_OUTPUTS.list
      : EVENT_TYPE_SUMMARY_OUTPUTS.page,
  );
  return builder.finish();
}
