import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  addEventReportSource,
  createEventReportSourceContext,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  EVENT_CONTEXT_CARDS,
  EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES,
  type EventContextCardDefinition,
  type EventContextCardKey,
  type EventContextOwnerAttribute,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import { semanticPageDimension } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export const EVENT_CONTEXT_REPORT_OUTPUT = "event-context-cards";
export const EVENT_CONTEXT_REPORT_FIELDS = [
  "cardType",
  "value",
  "label",
  "views",
  "sessions",
  "visitors",
] as const;

const EVENT_CARD_BASE_ATTRIBUTES = [
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
] as const;

function eventAttribute(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(events, `attribute:event.report.${name}`);
}

function ownerAttributeId(attribute: EventContextOwnerAttribute): string {
  return `event.report.${attribute}`;
}

function requiredOwnerAttributes(
  selected: readonly EventContextCardKey[],
): string[] {
  const attributes = new Set<string>(EVENT_CARD_BASE_ATTRIBUTES);
  for (const key of selected) {
    const definition = EVENT_CONTEXT_CARDS[key];
    if (definition.kind === "owner-raw" || definition.kind === "owner-trimmed")
      attributes.add(ownerAttributeId(definition.attribute));
    if (definition.kind === "page-dimension") {
      const dimension = semanticPageDimension(definition.dimension);
      if (!dimension)
        throw new Error(
          `event_context_unknown_page_dimension:${definition.dimension}`,
        );
      for (const dependency of dimension.dependencies) {
        const ownerAttribute =
          EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES[
            dependency as keyof typeof EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES
          ];
        if (!ownerAttribute)
          throw new Error(
            `event_context_owner_dimension_dependency_missing:${dependency}`,
          );
        attributes.add(ownerAttributeId(ownerAttribute));
      }
    }
  }
  return [...attributes];
}

function valueForCard(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  definition: EventContextCardDefinition,
): LogicalExpressionHandle {
  if (definition.kind === "owner-raw")
    return eventAttribute(builder, events, definition.attribute);
  if (definition.kind === "owner-trimmed")
    return builder.normalizeString(
      builder.coalesce(
        eventAttribute(builder, events, definition.attribute),
        builder.literal("", STRING),
      ),
      "trim-ascii-space",
    );
  if (definition.kind === "page-dimension") {
    const dimension = semanticPageDimension(definition.dimension);
    if (!dimension)
      throw new Error(
        `event_context_unknown_page_dimension:${definition.dimension}`,
      );
    return builder.pageDimension(
      definition.dimension,
      Object.fromEntries(
        dimension.dependencies.map((dependency) => {
          const ownerAttribute =
            EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES[
              dependency as keyof typeof EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES
            ];
          if (!ownerAttribute)
            throw new Error(
              `event_context_owner_dimension_dependency_missing:${dependency}`,
            );
          return [dependency, eventAttribute(builder, events, ownerAttribute)];
        }),
      ),
    );
  }
  throw new Error("event_context_boundary_card_requires_page_source");
}

function nonemptyCardValue(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
  return builder.compare(
    "neq",
    builder.normalizeString(
      builder.coalesce(value, builder.literal("", STRING)),
      "trim-ascii-space",
    ),
    builder.literal("", STRING),
  );
}

function eventCountMeasures(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
) {
  const distinctNonempty = (value: LogicalExpressionHandle) =>
    builder.caseWhen(
      [
        {
          when: builder.compare("neq", value, builder.literal("", STRING)),
          then: value,
        },
      ],
      builder.literal(null, STRING),
    );
  return [
    { name: "views", kind: "count-rows" as const },
    {
      name: "sessions",
      kind: "count-distinct" as const,
      expression: distinctNonempty(
        eventAttribute(builder, events, "ownerSessionId"),
      ),
    },
    {
      name: "visitors",
      kind: "count-distinct" as const,
      expression: distinctNonempty(
        eventAttribute(builder, events, "ownerVisitorId"),
      ),
    },
  ];
}

function projectRankedCard(
  builder: LogicalPlanBuilder,
  aggregate: LogicalRelationHandle,
  cardType: EventContextCardKey,
  geo: boolean,
  limit: number,
): LogicalRelationHandle {
  const projected = builder.project(aggregate, {
    cardType: builder.literal(cardType, STRING),
    value: builder.slot(aggregate, "value"),
    views: builder.slot(aggregate, "views"),
    sessions: builder.slot(aggregate, "sessions"),
    visitors: builder.slot(aggregate, "visitors"),
  });
  const ranked = builder.rankedMembers(projected, {
    groups: [],
    order: [
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "sessions", direction: "desc", nulls: "last" },
      { slot: "visitors", direction: "desc", nulls: "last" },
      { slot: "value", direction: "asc", nulls: "first" },
    ],
  });
  const limited = builder.filter(
    ranked,
    builder.compare(
      "lte",
      builder.slot(ranked, "rank"),
      builder.literal(limit, NUMBER),
    ),
  );
  return builder.project(limited, {
    cardType: builder.slot(limited, "cardType"),
    value: builder.slot(limited, "value"),
    label: geo
      ? builder.coalesce(
          builder.slot(limited, "value"),
          builder.literal(null, STRING),
        )
      : builder.literal(null, STRING),
    views: builder.slot(limited, "views"),
    sessions: builder.slot(limited, "sessions"),
    visitors: builder.slot(limited, "visitors"),
    cardRank: builder.slot(limited, "rank"),
  });
}

function ordinaryCardRows(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  key: EventContextCardKey,
  definition: Exclude<EventContextCardDefinition, { kind: "session-boundary" }>,
  limit: number,
): LogicalRelationHandle {
  const value = valueForCard(builder, events, definition);
  const input = definition.includeEmpty
    ? events
    : builder.filter(events, nonemptyCardValue(builder, value));
  const aggregate = builder.aggregate(
    input,
    { value },
    eventCountMeasures(builder, input),
  );
  return projectRankedCard(builder, aggregate, key, definition.geo, limit);
}

function boundaryPages(
  builder: LogicalPlanBuilder,
  input: {
    readonly siteId: string;
    readonly queryTime: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
    readonly subject: ReturnType<
      typeof createEventReportSourceContext
    >["subject"];
    readonly time: ReturnType<typeof createEventReportSourceContext>["time"];
  },
): LogicalRelationHandle {
  const selection = input.scopePlan
    ? createSemanticScopedSourceSelection({
        profile: "prepared-scoped-reader-window-v1",
        filters: input.filters,
        subject: input.subject,
        time: input.time,
        expectedPlan: input.scopePlan,
      })
    : createSemanticScopedSourceSelection({
        profile: "direct-page-analytics-v1",
        filters: EMPTY_FILTER_DOCUMENT,
        subject: input.subject,
        time: input.time,
      });
  return builder.source("page", {
    temporalDomain: "candidate",
    attributes: [
      "page.report.sessionId",
      "page.report.startedAt",
      "page.report.localId",
      "page.report.pathname",
    ],
    selection,
  });
}

function boundaryCardRows(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  pages: LogicalRelationHandle,
  key: "entry" | "exit",
  direction: "asc" | "desc",
  limit: number,
): LogicalRelationHandle {
  const rawSessionId = eventAttribute(builder, events, "ownerSessionId");
  const sessionValues = builder.project(events, { sessionId: rawSessionId });
  const eligibleSessions = builder.filter(
    sessionValues,
    nonemptyCardValue(builder, builder.slot(sessionValues, "sessionId")),
  );
  const uniqueSessions = builder.distinct(eligibleSessions, [
    { input: "sessionId" },
  ]);
  const pagesForEventSessions = builder.semiJoin(pages, uniqueSessions, [
    {
      left: "attribute:page.report.sessionId",
      right: "sessionId",
    },
  ]);
  const pathname = builder.slot(
    pagesForEventSessions,
    "attribute:page.report.pathname",
  );
  const eligiblePages = builder.filter(
    pagesForEventSessions,
    nonemptyCardValue(builder, pathname),
  );
  const boundary = builder.orderedMember(eligiblePages, {
    groups: ["attribute:page.report.sessionId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction,
        nulls: "first",
      },
      {
        slot: "attribute:page.report.localId",
        direction,
        nulls: "first",
      },
    ],
  });
  const boundaryValues = builder.project(boundary, {
    sessionId: builder.slot(boundary, "attribute:page.report.sessionId"),
    value: builder.slot(boundary, "attribute:page.report.pathname"),
  });
  const eventsWithBoundary = builder.join(events, boundaryValues, [
    {
      left: "attribute:event.report.ownerSessionId",
      right: "sessionId",
    },
  ]);
  const aggregate = builder.aggregate(
    eventsWithBoundary,
    { value: builder.slot(eventsWithBoundary, "right.value") },
    eventCountMeasures(builder, eventsWithBoundary),
  );
  return projectRankedCard(builder, aggregate, key, false, limit);
}

/** Builds the finite Event Context card set from one typed Event Source. */
export function buildEventContextReportPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly limit: number;
  readonly selectedKeys?: readonly EventContextCardKey[];
}): ValidatedLogicalPlan {
  const selectedSet = new Set(input.selectedKeys ?? EVENT_CONTEXT_CARD_KEYS);
  const selected = EVENT_CONTEXT_CARD_KEYS.filter((key) =>
    selectedSet.has(key),
  );
  const context = createEventReportSourceContext({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.scopePlan
      ? { preparedTimePolicy: "reader-window" as const }
      : {}),
  });
  const attributes = requiredOwnerAttributes(selected);
  if (input.eventName) attributes.push("event.report.eventName");
  const events = addEventReportSource(context, {
    attributes,
    ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
    eventNameInputSemantics: "legacy-truthy-raw",
  });

  if (selected.length === 0) return context.builder.finish();

  const needsBoundaryPages = selected.some(
    (key) => EVENT_CONTEXT_CARDS[key].kind === "session-boundary",
  );
  const pages = needsBoundaryPages
    ? boundaryPages(context.builder, {
        siteId: input.siteId,
        queryTime: input.queryTime,
        filters: input.filters,
        ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
        subject: context.subject,
        time: context.time,
      })
    : undefined;

  const cardRows = selected.map((key) => {
    const definition = EVENT_CONTEXT_CARDS[key];
    if (definition.kind === "session-boundary") {
      if (!pages) throw new Error("event_context_boundary_page_source_missing");
      return boundaryCardRows(
        context.builder,
        events,
        pages,
        key as "entry" | "exit",
        definition.direction === "first" ? "asc" : "desc",
        input.limit,
      );
    }
    return ordinaryCardRows(
      context.builder,
      events,
      key,
      definition,
      input.limit,
    );
  });
  let rows =
    cardRows.length === 1
      ? cardRows[0]!
      : context.builder.appendRows(cardRows, [
          "cardType",
          "value",
          "label",
          "views",
          "sessions",
          "visitors",
          "cardRank",
        ]);
  rows = context.builder.sort(rows, [
    { slot: "cardType", direction: "asc", nulls: "last" },
    { slot: "cardRank", direction: "asc", nulls: "last" },
  ]);
  context.builder.output(
    EVENT_CONTEXT_REPORT_OUTPUT,
    rows,
    EVENT_CONTEXT_REPORT_FIELDS.map((name) => ({ name, slot: name })),
  );
  return context.builder.finish();
}
