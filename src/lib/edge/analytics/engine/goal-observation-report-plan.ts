import {
  createQueryTime,
  type FilterDocument,
  type Interval,
  type QueryWindow,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";

const STRING = { kind: "scalar", scalar: "string" } as const;
const BOOLEAN = { kind: "scalar", scalar: "boolean" } as const;
const PAGE_ATTRIBUTES = [
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.startedAt",
] as const;
const EVENT_ATTRIBUTES = [
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.occurredAt",
] as const;

export const GOAL_SUMMARY_REPORT_OUTPUT = "goal-summary-aggregate";
export const GOAL_TIMESERIES_REPORT_OUTPUT = "goal-timeseries-aggregate";

interface GoalObservationReportSources {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly goalPages: LogicalRelationHandle;
  readonly goalEvents: LogicalRelationHandle;
}

function createGoalObservationReportSources(input: {
  readonly operation: "goal-summary" | "goal-timeseries";
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly goalFilter: FilterDocument;
}): GoalObservationReportSources {
  const metadata = scopedFilterMetadata(input.filters);
  if (!metadata && input.filters.root !== null)
    throw new Error("scoped_dataset_required");

  const queryTime = createQueryTime(
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    input.window.nowMs,
  );
  const time = semanticTemporalDomainsFromQueryTime(queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const scopePlan: ScopedFilterPlan | undefined = metadata?.plan;
  const pageSelectionInput = {
    profile: scopePlan
      ? ("prepared-scoped-reader-window-v1" as const)
      : ("direct-page-analytics-v1" as const),
    filters: input.filters,
    subject,
    time,
    ...(scopePlan ? { expectedPlan: scopePlan } : {}),
  } as const;
  const eventSelectionInput = {
    profile: scopePlan
      ? ("prepared-scoped-reader-window-v1" as const)
      : ("direct-event-analytics-v1" as const),
    filters: input.filters,
    subject,
    time,
    ...(scopePlan ? { expectedPlan: scopePlan } : {}),
  } as const;
  const basePageSelection =
    createSemanticScopedSourceSelection(pageSelectionInput);
  const baseEventSelection =
    createSemanticScopedSourceSelection(eventSelectionInput);
  const goalPageSelection =
    input.goalFilter.root === null
      ? basePageSelection
      : createSemanticScopedSourceSelection({
          ...pageSelectionInput,
          postObservationFilter: createSemanticPostObservationFilter({
            filter: input.goalFilter,
          }),
        });
  const goalEventSelection =
    input.goalFilter.root === null
      ? baseEventSelection
      : createSemanticScopedSourceSelection({
          ...eventSelectionInput,
          postObservationFilter: createSemanticPostObservationFilter({
            filter: input.goalFilter,
          }),
        });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(scopePlan?.scope ?? "event"),
    originOperation: input.operation,
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: PAGE_ATTRIBUTES,
    selection: basePageSelection,
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: EVENT_ATTRIBUTES,
    selection: baseEventSelection,
  });
  const goalPages =
    goalPageSelection === basePageSelection
      ? pages
      : builder.source("page", {
          temporalDomain: "candidate",
          attributes: PAGE_ATTRIBUTES,
          selection: goalPageSelection,
        });
  const goalEvents =
    goalEventSelection === baseEventSelection
      ? events
      : builder.source("event", {
          temporalDomain: "candidate",
          attributes: EVENT_ATTRIBUTES,
          selection: goalEventSelection,
        });
  return { builder, pages, events, goalPages, goalEvents };
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "sessionId" | "visitorId" | "startedAt",
): LogicalExpressionHandle {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function eventAttribute(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  name: "ownerSessionId" | "ownerVisitorId" | "occurredAt",
): LogicalExpressionHandle {
  return builder.slot(events, `attribute:event.report.${name}`);
}

function nonBlankRawIdentity(
  builder: LogicalPlanBuilder,
  identity: LogicalExpressionHandle,
): LogicalExpressionHandle {
  const nonBlank = builder.compare(
    "neq",
    builder.normalizeString(identity, "trim-ascii-space"),
    builder.literal("", STRING),
  );
  return builder.caseWhen(
    [{ when: nonBlank, then: identity }],
    builder.literal(null, STRING),
  );
}

function projectObservationIdentities(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly sessionId: LogicalExpressionHandle;
  readonly visitorId: LogicalExpressionHandle;
  readonly isGoal: boolean;
  readonly bucket?: LogicalExpressionHandle;
}): LogicalRelationHandle {
  return input.builder.project(input.relation, {
    ...(input.bucket ? { bucket: input.bucket } : {}),
    sessionId: input.sessionId,
    visitorId: input.visitorId,
    isGoal: input.builder.literal(input.isGoal, BOOLEAN),
  });
}

function appendObservationIdentities(
  builder: LogicalPlanBuilder,
  sources: GoalObservationReportSources,
  input: { readonly includeBucket: boolean; readonly interval?: Interval },
): LogicalRelationHandle {
  const pageRows = (relation: LogicalRelationHandle, isGoal: boolean) =>
    projectObservationIdentities({
      builder,
      relation,
      sessionId: pageAttribute(builder, relation, "sessionId"),
      visitorId: pageAttribute(builder, relation, "visitorId"),
      isGoal,
      ...(input.includeBucket
        ? {
            bucket: builder.bucketIndex(
              builder.timeBucket(
                pageAttribute(builder, relation, "startedAt"),
                input.interval!,
              ),
            ),
          }
        : {}),
    });
  const eventRows = (relation: LogicalRelationHandle, isGoal: boolean) =>
    projectObservationIdentities({
      builder,
      relation,
      sessionId: eventAttribute(builder, relation, "ownerSessionId"),
      visitorId: eventAttribute(builder, relation, "ownerVisitorId"),
      isGoal,
      ...(input.includeBucket
        ? {
            bucket: builder.bucketIndex(
              builder.timeBucket(
                eventAttribute(builder, relation, "occurredAt"),
                input.interval!,
              ),
            ),
          }
        : {}),
    });
  const relations = [
    pageRows(sources.pages, false),
    eventRows(sources.events, false),
    pageRows(sources.goalPages, true),
    eventRows(sources.goalEvents, true),
  ];
  return builder.appendRows(
    relations,
    input.includeBucket
      ? ["bucket", "sessionId", "visitorId", "isGoal"]
      : ["sessionId", "visitorId", "isGoal"],
  );
}

function outputSummary(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
): ValidatedLogicalPlan {
  const isGoal = builder.slot(observations, "isGoal");
  const isBase = builder.compare("eq", isGoal, builder.literal(false, BOOLEAN));
  const goalSession = builder.compare(
    "eq",
    isGoal,
    builder.literal(true, BOOLEAN),
  );
  const sessionId = builder.slot(observations, "sessionId");
  const visitorId = builder.slot(observations, "visitorId");
  const aggregate = builder.aggregate(observations, {}, [
    {
      name: "totalSessions",
      kind: "count-distinct",
      expression: builder.caseWhen(
        [{ when: isBase, then: nonBlankRawIdentity(builder, sessionId) }],
        builder.literal(null, STRING),
      ),
    },
    {
      name: "convertedSessions",
      kind: "count-distinct",
      expression: builder.caseWhen(
        [{ when: goalSession, then: nonBlankRawIdentity(builder, sessionId) }],
        builder.literal(null, STRING),
      ),
    },
    {
      name: "totalVisitors",
      kind: "count-distinct",
      expression: builder.caseWhen(
        [{ when: isBase, then: nonBlankRawIdentity(builder, visitorId) }],
        builder.literal(null, STRING),
      ),
    },
    {
      name: "convertedVisitors",
      kind: "count-distinct",
      expression: builder.caseWhen(
        [{ when: goalSession, then: nonBlankRawIdentity(builder, visitorId) }],
        builder.literal(null, STRING),
      ),
    },
  ]);
  builder.output(GOAL_SUMMARY_REPORT_OUTPUT, aggregate, [
    { name: "totalSessions", slot: "totalSessions" },
    { name: "convertedSessions", slot: "convertedSessions" },
    { name: "totalVisitors", slot: "totalVisitors" },
    { name: "convertedVisitors", slot: "convertedVisitors" },
  ]);
  return builder.finish();
}

function outputTimeseries(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
): ValidatedLogicalPlan {
  const withBucket = builder.filter(
    observations,
    builder.isNull(builder.slot(observations, "bucket"), true),
  );
  const isGoal = builder.slot(withBucket, "isGoal");
  const isBase = builder.compare("eq", isGoal, builder.literal(false, BOOLEAN));
  const goalMatch = builder.compare(
    "eq",
    isGoal,
    builder.literal(true, BOOLEAN),
  );
  const sessionId = builder.slot(withBucket, "sessionId");
  const visitorId = builder.slot(withBucket, "visitorId");
  const grouped = builder.aggregate(
    withBucket,
    { bucket: builder.slot(withBucket, "bucket") },
    [
      {
        name: "totalSessions",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: isBase, then: nonBlankRawIdentity(builder, sessionId) }],
          builder.literal(null, STRING),
        ),
      },
      {
        name: "convertedSessions",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: goalMatch, then: nonBlankRawIdentity(builder, sessionId) }],
          builder.literal(null, STRING),
        ),
      },
      {
        name: "totalVisitors",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: isBase, then: nonBlankRawIdentity(builder, visitorId) }],
          builder.literal(null, STRING),
        ),
      },
      {
        name: "convertedVisitors",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: goalMatch, then: nonBlankRawIdentity(builder, visitorId) }],
          builder.literal(null, STRING),
        ),
      },
    ],
  );
  const sorted = builder.sort(grouped, [
    { slot: "bucket", direction: "asc", nulls: "last" },
  ]);
  builder.output(GOAL_TIMESERIES_REPORT_OUTPUT, sorted, [
    { name: "bucket", slot: "bucket" },
    { name: "totalSessions", slot: "totalSessions" },
    { name: "convertedSessions", slot: "convertedSessions" },
    { name: "totalVisitors", slot: "totalVisitors" },
    { name: "convertedVisitors", slot: "convertedVisitors" },
  ]);
  return builder.finish();
}

export function buildGoalSummaryReportPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly goalFilter: FilterDocument;
}): ValidatedLogicalPlan {
  const sources = createGoalObservationReportSources({
    ...input,
    operation: "goal-summary",
  });
  return outputSummary(
    sources.builder,
    appendObservationIdentities(sources.builder, sources, {
      includeBucket: false,
    }),
  );
}

export function buildGoalTimeseriesReportPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly interval: Interval;
  readonly filters: FilterDocument;
  readonly goalFilter: FilterDocument;
}): ValidatedLogicalPlan {
  const sources = createGoalObservationReportSources({
    ...input,
    operation: "goal-timeseries",
  });
  return outputTimeseries(
    sources.builder,
    appendObservationIdentities(sources.builder, sources, {
      includeBucket: true,
      interval: input.interval,
    }),
  );
}
