import type {
  EventRecordSortKey,
  ListSort,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/semantic/value-types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

export const EVENT_RECORD_PAGE_OUTPUT_ID = "event-record-page";
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const DATETIME = { kind: "scalar", scalar: "datetime" } as const;

export interface EventRecordPageCursor {
  readonly sortValue?: string | number;
  readonly occurredAt: number;
  readonly eventId: string;
  readonly eventPk: number;
}

export const EVENT_RECORD_ATTRIBUTES = [
  "event.report.internalPk",
  "event.report.localId",
  "event.report.eventName",
  "event.report.occurredAt",
  "event.report.receivedAt",
  "event.report.sequence",
  "event.report.ownerVisitId",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.ownerPathname",
  "event.report.ownerTitle",
  "event.report.ownerHostname",
  "event.report.ownerReferrerHost",
  "event.report.ownerCountry",
  "event.report.ownerRegion",
  "event.report.ownerCity",
  "event.report.ownerBrowser",
  "event.report.ownerBrowserVersion",
  "event.report.ownerOs",
  "event.report.ownerOsVersion",
  "event.report.ownerDeviceType",
  "event.report.nodeCount",
  "event.report.valueCount",
] as const;

export interface EventRecordPageOptions {
  readonly limit: number;
  readonly sort: ListSort<EventRecordSortKey>;
  readonly search?: string;
  readonly eventName?: string;
  readonly cursor?: EventRecordPageCursor | null;
}

function attribute(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(source, `attribute:event.report.${name}`);
}

function literal(
  builder: LogicalPlanBuilder,
  value: string | number,
  type: Extract<LogicalValueType, { readonly kind: "scalar" }>,
) {
  return builder.literal(value, type);
}

function comparison(
  builder: LogicalPlanBuilder,
  operator: "eq" | "gt" | "lt",
  left: ReturnType<typeof attribute>,
  right: ReturnType<typeof literal>,
) {
  return builder.compare(operator, left, right);
}

function cursorPredicate(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  cursor: EventRecordPageCursor,
  sort: ListSort<EventRecordSortKey>,
) {
  const occurredAt = attribute(builder, source, "occurredAt");
  const eventId = attribute(builder, source, "localId");
  const eventPk = attribute(builder, source, "internalPk");
  const occurredLiteral = literal(builder, cursor.occurredAt, DATETIME);
  const eventIdLiteral = literal(builder, cursor.eventId, STRING);
  const eventPkLiteral = literal(builder, cursor.eventPk, NUMBER);

  if (sort.key === "occurredAt") {
    const op = sort.direction === "asc" ? "gt" : "lt";
    return builder.or(
      comparison(builder, op, occurredAt, occurredLiteral),
      builder.and(
        comparison(builder, "eq", occurredAt, occurredLiteral),
        builder.or(
          comparison(builder, op, eventId, eventIdLiteral),
          builder.and(
            comparison(builder, "eq", eventId, eventIdLiteral),
            comparison(builder, op, eventPk, eventPkLiteral),
          ),
        ),
      ),
    );
  }

  if (typeof cursor.sortValue !== "string")
    throw new Error("event_record_page_cursor_sort_value_must_be_text");
  const primary = attribute(
    builder,
    source,
    sort.key === "eventName" ? "eventName" : "ownerPathname",
  );
  const primaryLiteral = literal(builder, cursor.sortValue, STRING);
  const op = sort.direction === "asc" ? "gt" : "lt";
  return builder.or(
    comparison(builder, op, primary, primaryLiteral),
    builder.and(
      comparison(builder, "eq", primary, primaryLiteral),
      builder.or(
        comparison(builder, "lt", occurredAt, occurredLiteral),
        builder.and(
          comparison(builder, "eq", occurredAt, occurredLiteral),
          builder.or(
            comparison(builder, "lt", eventId, eventIdLiteral),
            builder.and(
              comparison(builder, "eq", eventId, eventIdLiteral),
              comparison(builder, "lt", eventPk, eventPkLiteral),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Appends the record page search, cursor, ordering, limit, and output contract
 * to a caller-owned builder and Event relation. */
export function appendEventRecordPage(
  builder: LogicalPlanBuilder,
  inputEvents: LogicalRelationHandle,
  options: EventRecordPageOptions,
): LogicalRelationHandle {
  let events = inputEvents;
  const search = options.search;
  if (search) {
    const searchable = [
      "eventName",
      "localId",
      "ownerVisitId",
      "ownerSessionId",
      "ownerVisitorId",
      "ownerPathname",
      "ownerTitle",
      "ownerHostname",
    ] as const;
    events = builder.filter(
      events,
      builder.or(
        ...searchable.map((name) =>
          builder.stringMatch(
            "contains",
            attribute(builder, events, name),
            search.toLowerCase(),
            false,
            undefined,
            "legacy-record-search-v1",
          ),
        ),
      ),
    );
  }

  if (options.cursor) {
    events = builder.filter(
      events,
      cursorPredicate(builder, events, options.cursor, options.sort),
    );
  }

  const sort = options.sort;
  const order: {
    readonly slot: string;
    readonly direction: "asc" | "desc";
    readonly nulls: "first" | "last";
  }[] =
    sort.key === "occurredAt"
      ? [
          {
            slot: "attribute:event.report.occurredAt",
            direction: sort.direction,
            nulls: sort.direction === "asc" ? "first" : "last",
          },
          {
            slot: "attribute:event.report.localId",
            direction: sort.direction,
            nulls: sort.direction === "asc" ? "first" : "last",
          },
          {
            slot: "attribute:event.report.internalPk",
            direction: sort.direction,
            nulls: sort.direction === "asc" ? "first" : "last",
          },
        ]
      : [
          {
            slot:
              sort.key === "eventName"
                ? "attribute:event.report.eventName"
                : "attribute:event.report.ownerPathname",
            direction: sort.direction,
            nulls: sort.direction === "asc" ? "first" : "last",
          },
          {
            slot: "attribute:event.report.occurredAt",
            direction: "desc",
            nulls: "last",
          },
          {
            slot: "attribute:event.report.localId",
            direction: "desc",
            nulls: "last",
          },
          {
            slot: "attribute:event.report.internalPk",
            direction: "desc",
            nulls: "last",
          },
        ];
  events = builder.sort(events, order);
  events = builder.limit(events, options.limit + 1);

  const projections = {
    eventPk: attribute(builder, events, "internalPk"),
    eventId: attribute(builder, events, "localId"),
    eventName: attribute(builder, events, "eventName"),
    occurredAt: attribute(builder, events, "occurredAt"),
    receivedAt: attribute(builder, events, "receivedAt"),
    sequence: attribute(builder, events, "sequence"),
    visitId: attribute(builder, events, "ownerVisitId"),
    sessionId: attribute(builder, events, "ownerSessionId"),
    visitorId: attribute(builder, events, "ownerVisitorId"),
    pathname: attribute(builder, events, "ownerPathname"),
    title: attribute(builder, events, "ownerTitle"),
    hostname: attribute(builder, events, "ownerHostname"),
    referrerHost: attribute(builder, events, "ownerReferrerHost"),
    country: attribute(builder, events, "ownerCountry"),
    region: attribute(builder, events, "ownerRegion"),
    city: attribute(builder, events, "ownerCity"),
    browser: attribute(builder, events, "ownerBrowser"),
    browserVersion: attribute(builder, events, "ownerBrowserVersion"),
    os: attribute(builder, events, "ownerOs"),
    osVersion: attribute(builder, events, "ownerOsVersion"),
    deviceType: attribute(builder, events, "ownerDeviceType"),
    nodeCount: attribute(builder, events, "nodeCount"),
    valueCount: attribute(builder, events, "valueCount"),
  };
  const projected = builder.project(events, projections);
  builder.output(
    EVENT_RECORD_PAGE_OUTPUT_ID,
    projected,
    Object.keys(projections).map((name) => ({ name, slot: name })),
  );
  return projected;
}

/** Builds the shared Logical event-page query without D1 SQL or storage names. */
export function buildEventRecordPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly options: EventRecordPageOptions;
}): ValidatedLogicalPlan {
  const time = semanticTemporalDomainsFromQueryTime(input.queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const selection = createSemanticScopedSourceSelection({
    profile: input.scopePlan ? "prepared-scoped-v1" : "direct-event-records-v1",
    filters: input.filters,
    subject,
    time,
    ...(input.scopePlan ? { expectedPlan: input.scopePlan } : {}),
    ...(input.options.eventName !== undefined
      ? { eventName: input.options.eventName }
      : {}),
  });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(input.scopePlan?.scope ?? "event"),
    originOperation: "event-records",
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: EVENT_RECORD_ATTRIBUTES,
    selection,
  });

  appendEventRecordPage(builder, events, input.options);
  return builder.finish();
}
