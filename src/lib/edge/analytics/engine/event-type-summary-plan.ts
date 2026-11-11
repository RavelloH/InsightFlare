import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryAudience } from "@/lib/edge/analytics/contract/types";
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
import { type LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
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

export type EventTypePageQuery = Extract<
  EventTypeSummaryQuery,
  { readonly kind: "page" }
>;

export type EventTypeListQuery = Extract<
  EventTypeSummaryQuery,
  { readonly kind: "list" }
>;

export type EventTypeQualificationQuery =
  EventTypeListQuery | EventTypePageQuery;

export interface EventNameDimensionListRequest {
  readonly mode: "breakdown";
  readonly dimension: "event.name";
  readonly limit: number;
  readonly search?: string;
  readonly audience: QueryAudience;
}

/** Preserve the event.name list's existing page.limit → limit → 20 defaults. */
export function normalizeEventNameDimensionListRequest(input: {
  readonly mode: unknown;
  readonly dimension: unknown;
  readonly page?: unknown;
  readonly limit?: unknown;
  readonly search?: unknown;
  readonly audience: QueryAudience;
}): EventNameDimensionListRequest | null {
  if (input.mode !== "breakdown" || input.dimension !== "event.name")
    return null;
  const page =
    input.page && typeof input.page === "object"
      ? (input.page as { readonly limit?: unknown })
      : {};
  const limit =
    typeof page.limit === "number" && Number.isFinite(page.limit)
      ? page.limit
      : typeof input.limit === "number" && Number.isFinite(input.limit)
        ? input.limit
        : 20;
  return Object.freeze({
    mode: "breakdown",
    dimension: "event.name",
    limit,
    ...(typeof input.search === "string" ? { search: input.search } : {}),
    audience: input.audience,
  });
}

export type EventTypeSummaryQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> = EventQualificationPlan<Scope>;

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
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
}) {
  return buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
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

function addEventTypeSummaryOutput(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  query: EventTypeSummaryQuery,
): void {
  if (query.kind === "summary") {
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
    return;
  }

  let rows = eventValueFilter(
    builder,
    eventRollup(builder, events),
    query.search,
    query.kind === "list"
      ? Boolean(query.search)
      : Boolean(query.search?.trim()),
  );
  if (query.kind === "page" && query.cursor) {
    rows = applyEventTypeCursor(builder, rows, query.cursor);
  }
  rows = builder.sort(rows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "value", direction: "asc", nulls: "last" },
  ]);
  const limit = query.limit;
  if (query.kind === "page") {
    rows = builder.limit(rows, limit + 1);
  } else if (limit > 0) {
    rows = builder.limit(rows, limit);
  }
  addEventTypeOutput(
    builder,
    rows,
    query.kind === "list"
      ? EVENT_TYPE_SUMMARY_OUTPUTS.list
      : EVENT_TYPE_SUMMARY_OUTPUTS.page,
  );
}

/** Builds one validated Logical query for an Event type list, page, or summary. */
export function buildEventTypeSummaryPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly query: EventTypeSummaryQuery;
}): ValidatedLogicalPlan {
  const { builder, events } = eventSummarySource(input);
  addEventTypeSummaryOutput(builder, events, input.query);
  return builder.finish();
}

/** Builds the event-type page and Count controls in one authorized builder. */
export function buildEventTypeSummaryQualificationPlan<
  Count extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly siteId: string;
  readonly count: Count;
  readonly query: EventTypeQualificationQuery;
  readonly reportFilters?: FilterDocument;
}): EventTypeSummaryQualificationPlan<Count["scope"]> {
  if (
    input.count.scope === "event" &&
    (input.reportFilters !== undefined ||
      (input.query.kind !== "page" && input.query.kind !== "list"))
  )
    throw new Error("event_candidate_count_requires_event_type_query");
  const qualified = buildEventQualifiedSource({
    siteId: input.siteId,
    count: input.count,
    purpose: "event-types",
    ...(input.reportFilters ? { reportFilters: input.reportFilters } : {}),
  });
  addEventTypeSummaryOutput(qualified.builder, qualified.events, input.query);
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
    ...(qualified.qualification.candidateGrain
      ? { candidateGrain: qualified.qualification.candidateGrain }
      : {}),
    ...(qualified.qualification.additionalGroupedSummaries
      ? {
          additionalGroupedSummaryRelationIds:
            qualified.qualification.additionalGroupedSummaries.map(
              ({ id }) => id,
            ),
        }
      : {}),
    controlOutputId: EVENT_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze([
      input.query.kind === "list"
        ? EVENT_TYPE_SUMMARY_OUTPUTS.list
        : EVENT_TYPE_SUMMARY_OUTPUTS.page,
    ]),
    numericCompatibilityFields:
      qualified.qualification.numericCompatibilityFields,
    scope: qualified.qualification.scope,
  } as EventTypeSummaryQualificationPlan<Count["scope"]>;
}
