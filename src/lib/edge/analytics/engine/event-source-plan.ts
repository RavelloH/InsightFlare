import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime, SiteId } from "@/lib/edge/analytics/contract/types";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const EVENT_REPORT_BASE_ATTRIBUTES = [
  "event.report.eventName",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
] as const;

export const EVENT_REPORT_TREND_ATTRIBUTES = [
  ...EVENT_REPORT_BASE_ATTRIBUTES,
  "event.report.occurredAt",
] as const;

export type EventNameInputSemantics =
  "trimmed-nonempty" | "legacy-truthy-raw" | "defined-raw-value";

export interface EventReportSourceContext {
  readonly builder: LogicalPlanBuilder;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window";
  /** Request-private Event membership bound by the Provider at execution. */
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly subject: SemanticSubjectDomain;
  readonly time: SemanticTemporalDomains;
}

/** Uses an existing semantic builder so qualification and report Sources share
 * the same authorized subject, temporal domains, scope, and relation IDs. */
export function createEventReportSourceContextForBuilder(
  builder: LogicalPlanBuilder,
  filters: FilterDocument,
  options: {
    readonly scopePlan?: ScopedFilterPlan;
    readonly preparedTimePolicy?: "reader-window";
  } = {},
): EventReportSourceContext {
  if (options.preparedTimePolicy && !options.scopePlan)
    throw new Error("event_source_reader_window_requires_prepared_scope");
  return {
    builder,
    filters,
    ...(options.scopePlan ? { scopePlan: options.scopePlan } : {}),
    ...(options.preparedTimePolicy
      ? { preparedTimePolicy: options.preparedTimePolicy }
      : {}),
    subject: builder.context.subject,
    time: builder.context.time,
  };
}

/** Creates one builder/context for Event report Sources with separate gates. */
export function createEventReportSourceContext(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
}): EventReportSourceContext {
  if (input.preparedTimePolicy && !input.scopePlan)
    throw new Error("event_source_reader_window_requires_prepared_scope");
  if (input.qualificationDependencyRefs && !input.scopePlan)
    throw new Error("event_source_dependency_requires_prepared_scope");
  const time = semanticTemporalDomainsFromQueryTime(input.queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(input.scopePlan?.scope ?? "event"),
    originOperation: "event-records",
  });
  return {
    builder,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.preparedTimePolicy
      ? { preparedTimePolicy: input.preparedTimePolicy }
      : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    subject,
    time,
  };
}

/** Adds one immutable Event Source to a shared report context. */
export function addEventReportSource(
  context: EventReportSourceContext,
  input: {
    readonly attributes: readonly string[];
    readonly eventName?: string;
    readonly eventNameInputSemantics?: EventNameInputSemantics;
  },
): LogicalRelationHandle {
  const readerWindow = context.preparedTimePolicy === "reader-window";
  const eventNameSemantics =
    input.eventNameInputSemantics ?? "trimmed-nonempty";
  if (
    readerWindow &&
    input.eventName !== undefined &&
    eventNameSemantics !== "legacy-truthy-raw"
  )
    throw new Error(
      "event_source_reader_window_requires_legacy_truthy_raw_event_name",
    );
  const selection = createSemanticScopedSourceSelection({
    profile: context.scopePlan
      ? readerWindow
        ? "prepared-scoped-reader-window-v1"
        : "prepared-scoped-v1"
      : "direct-event-analytics-v1",
    filters: context.filters,
    subject: context.subject,
    time: context.time,
    ...(context.scopePlan ? { expectedPlan: context.scopePlan } : {}),
    ...(context.qualificationDependencyRefs
      ? {
          qualificationDependencyRefs: context.qualificationDependencyRefs,
        }
      : {}),
    ...(!readerWindow && input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics: eventNameSemantics,
        }
      : {}),
  });
  const events = context.builder.source("event", {
    temporalDomain: "candidate",
    attributes: input.attributes,
    selection,
  });
  if (!readerWindow || !input.eventName) return events;
  const eventName = context.builder.coalesce(
    context.builder.slot(events, "attribute:event.report.eventName"),
    context.builder.literal("", { kind: "scalar", scalar: "string" }),
  );
  return context.builder.filter(
    events,
    context.builder.compare(
      "eq",
      context.builder.normalizeString(eventName, "trim-ascii-space"),
      context.builder.literal(input.eventName, {
        kind: "scalar",
        scalar: "string",
      }),
    ),
  );
}

/** Builds a shared value-only Event Source used by event summaries and trends. */
export function buildEventReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly attributes: readonly string[];
  readonly eventName?: string;
  readonly eventNameInputSemantics?: EventNameInputSemantics;
}): {
  readonly builder: LogicalPlanBuilder;
  readonly events: LogicalRelationHandle;
} {
  const context = createEventReportSourceContext({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.preparedTimePolicy
      ? { preparedTimePolicy: input.preparedTimePolicy }
      : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
  });
  return {
    builder: context.builder,
    events: addEventReportSource(context, {
      attributes: input.attributes,
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.eventNameInputSemantics
        ? { eventNameInputSemantics: input.eventNameInputSemantics }
        : {}),
    }),
  };
}

/** Keep nonblank raw identity counting identical across Event summary/trend plans. */
export function nonEmptyDistinctValue(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
  const stringType = { kind: "scalar", scalar: "string" } as const;
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", value, builder.literal("", stringType)),
        then: value,
      },
    ],
    builder.literal(null, stringType),
  );
}
