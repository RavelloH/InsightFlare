import type { Interval, QueryTime } from "@/lib/edge/analytics/contract";
import {
  EMPTY_FILTER_DOCUMENT,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

const RETENTION_PAGE_ATTRIBUTES = [
  "page.report.visitorId",
  "page.report.startedAt",
] as const;

interface JourneyRetentionPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly granularity: Interval;
}

function pageField(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "visitorId" | "startedAt",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

/** Appends the shared cohort/returning-visitor algorithm to caller-owned Pages. */
export function appendJourneyRetentionReport(
  builder: LogicalPlanBuilder,
  cohortPages: LogicalRelationHandle,
  trackingPages: LogicalRelationHandle,
  granularity: Interval,
): LogicalRelationHandle {
  const cohortBucket = builder.bucketIndex(
    builder.timeBucket(
      pageField(builder, cohortPages, "startedAt"),
      granularity,
    ),
  );
  const eligibleCohortPages = builder.filter(
    cohortPages,
    builder.and(
      builder.compare(
        "neq",
        pageField(builder, cohortPages, "visitorId"),
        builder.literal("", STRING),
      ),
      builder.isNull(cohortBucket, true),
    ),
  );
  const cohorts = builder.aggregate(
    eligibleCohortPages,
    { visitorId: pageField(builder, cohortPages, "visitorId") },
    [{ name: "cohortBucket", kind: "min", expression: cohortBucket }],
  );

  const trackingBucket = builder.bucketIndex(
    builder.timeBucket(
      pageField(builder, trackingPages, "startedAt"),
      granularity,
    ),
  );
  const eligibleTrackingPages = builder.filter(
    trackingPages,
    builder.and(
      builder.compare(
        "neq",
        pageField(builder, trackingPages, "visitorId"),
        builder.literal("", STRING),
      ),
      builder.isNull(trackingBucket, true),
    ),
  );
  const selectedVisitors = builder.join(eligibleTrackingPages, cohorts, [
    { left: "attribute:page.report.visitorId", right: "visitorId" },
  ]);
  const trackingFromCohort = builder.filter(
    selectedVisitors,
    builder.compare(
      "gte",
      trackingBucket,
      builder.slot(selectedVisitors, "right.cohortBucket"),
    ),
  );
  const uniqueVisitorBuckets = builder.aggregate(
    trackingFromCohort,
    {
      visitorId: builder.slot(
        trackingFromCohort,
        "attribute:page.report.visitorId",
      ),
      cohortBucket: builder.slot(trackingFromCohort, "right.cohortBucket"),
      visitBucket: trackingBucket,
    },
    [],
  );
  const totals = builder.aggregate(
    uniqueVisitorBuckets,
    {
      cohortBucket: builder.slot(uniqueVisitorBuckets, "cohortBucket"),
      visitBucket: builder.slot(uniqueVisitorBuckets, "visitBucket"),
    },
    [{ name: "visitors", kind: "count-rows" }],
  );
  const sorted = builder.sort(totals, [
    { slot: "cohortBucket", direction: "asc", nulls: "first" },
    { slot: "visitBucket", direction: "asc", nulls: "first" },
  ]);
  builder.output("journey-retention", sorted, [
    { name: "cohortBucket", slot: "cohortBucket" },
    { name: "visitBucket", slot: "visitBucket" },
    { name: "visitors", slot: "visitors" },
  ]);
  return sorted;
}

function retentionSource(input: JourneyRetentionPlanInput) {
  const source = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    attributes: RETENTION_PAGE_ATTRIBUTES,
  });

  if (input.scopePlan || input.filters.root === null)
    return { ...source, trackingPages: source.pages };

  // Direct filters choose the cohort; SEM050 keeps later tracking on every
  // Page in the reader window. Prepared queries already expose their final
  // scoped Page set and intentionally reuse it for both stages.
  const trackingSelection = createSemanticScopedSourceSelection({
    profile: "direct-page-analytics-v1",
    filters: EMPTY_FILTER_DOCUMENT,
    subject: source.builder.context.subject,
    time: source.builder.context.time,
  });
  const trackingPages = source.builder.source("page", {
    temporalDomain: "candidate",
    attributes: RETENTION_PAGE_ATTRIBUTES,
    selection: trackingSelection,
  });
  return { ...source, trackingPages };
}

/** Builds retention cohorts from matching Pages and tracks the selected visitors. */
export function buildJourneyRetentionPlan(input: JourneyRetentionPlanInput) {
  const { builder, pages: cohortPages, trackingPages } = retentionSource(input);
  appendJourneyRetentionReport(
    builder,
    cohortPages,
    trackingPages,
    input.granularity,
  );
  return builder.finish();
}
