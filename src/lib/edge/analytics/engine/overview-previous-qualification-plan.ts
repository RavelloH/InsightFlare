import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { EventQualificationReportSource } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { appendOverviewAggregateReport } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import {
  buildOverviewTrendQualificationPlan,
  OVERVIEW_CURRENT_COHORT_OUTPUT,
  OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  type OverviewTrendQualificationConfiguration,
  type OverviewTrendQualificationPlan,
} from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const AGGREGATE_FIELDS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

export type OverviewPreviousConfiguration = Extract<
  OverviewTrendQualificationConfiguration,
  {
    readonly kind:
      "overview-with-previous" | "overview-with-previous-and-detail";
  }
>;

function sameQueryTime(left: QueryTime, right: QueryTime): boolean {
  const leftRead = left.readRange ?? left.range;
  const rightRead = right.readRange ?? right.range;
  return (
    left.range.startMs === right.range.startMs &&
    left.range.endExclusiveMs === right.range.endExclusiveMs &&
    left.reportingTimeZone === right.reportingTimeZone &&
    left.capturedAtMs === right.capturedAtMs &&
    leftRead.startMs === rightRead.startMs &&
    leftRead.endExclusiveMs === rightRead.endExclusiveMs &&
    left.filterRange?.startMs === right.filterRange?.startMs &&
    left.filterRange?.endExclusiveMs === right.filterRange?.endExclusiveMs &&
    left.filterRangeEmpty === right.filterRangeEmpty &&
    left.fullHistory === right.fullHistory
  );
}

export interface OverviewPreviousQualificationPlan {
  readonly plan: ValidatedLogicalPlan;
  readonly childQualification: OverviewTrendQualificationPlan;
  readonly primaryReportSourceRelationId: EventQualificationReportSource["relationId"];
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
  readonly reportOutputIds: readonly string[];
  readonly controlOutputId: string;
}

function configurationHasDetail(
  configuration: OverviewPreviousConfiguration,
): configuration is Extract<
  OverviewPreviousConfiguration,
  { readonly kind: "overview-with-previous-and-detail" }
> {
  return configuration.kind === "overview-with-previous-and-detail";
}

function previousSelection(input: {
  readonly siteId: string;
  readonly currentTime: QueryTime;
  readonly previousTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly selectionSubject: OverviewPreviousQualificationPlan["plan"]["context"]["subject"];
}): SemanticScopedSourceSelection {
  const metadata = scopedFilterMetadata(input.filters);
  if (
    !metadata ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    metadata.resolvedScope !== input.scopePlan.scope ||
    metadata.plan !== input.scopePlan ||
    !sameQueryTime(metadata.time, input.currentTime)
  )
    throw new Error("overview_previous_qualification_request_context_mismatch");
  const split = splitPageDimensionNativeFilters(input.filters);
  if (split.kind === "unsupported")
    throw new Error("overview_previous_native_filter_split_unsupported");
  const nativePlan = createScopedFilterPlan(
    "overview",
    split.filters,
    input.scopePlan.scope,
  );
  const previousTime = semanticTemporalDomainsFromQueryTime(input.previousTime);
  if (!nativePlan) {
    if (split.filters.root !== null)
      throw new Error("overview_previous_native_scope_plan_missing");
    return createSemanticScopedSourceSelection({
      profile: "direct-page-analytics-v1",
      filters: split.filters,
      subject: input.selectionSubject,
      time: previousTime,
    });
  }
  if (nativePlan.scope !== input.scopePlan.scope)
    throw new Error("overview_previous_native_scope_mismatch");
  const nativeFilters = attachScopedFilterMetadata(split.filters, {
    requestedScope: nativePlan.scope,
    resolvedScope: nativePlan.scope,
    plan: nativePlan,
    // Preserve the current preparation time. The Page/Event sources use the
    // previous candidate window while retaining the exact current Count prep.
    time: metadata.time,
    siteIds: metadata.siteIds,
  });
  return createSemanticScopedSourceSelection({
    profile: "prepared-scoped-reader-window-v1",
    filters: nativeFilters,
    subject: input.selectionSubject,
    time: previousTime,
    expectedPlan: nativePlan,
    preparedPlanOperation: "overview",
  });
}

/** Build current Count once, import its qualified cohort, and report both windows. */
export function buildOverviewPreviousQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly configuration: OverviewPreviousConfiguration;
}): OverviewPreviousQualificationPlan {
  const hasDetail = configurationHasDetail(input.configuration);
  const childQualification = buildOverviewTrendQualificationPlan({
    semanticOperation: "overview",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    configuration: hasDetail
      ? { kind: "overview-with-detail", interval: input.configuration.interval }
      : { kind: "aggregate" },
    includeCurrentCohort: true,
  });
  const parentBuilder = new LogicalPlanBuilder({
    ...childQualification.plan.context,
    time: semanticTemporalDomainsFromQueryTime(
      input.configuration.previousTime,
    ),
    originOperation: "overview",
  });

  const currentAggregate = parentBuilder.importAnalysisResult(
    childQualification.plan,
    "overview-aggregate",
    AGGREGATE_FIELDS.map((field) => ({ field })),
  );
  parentBuilder.output(
    "overview-current-aggregate",
    currentAggregate,
    AGGREGATE_FIELDS.map((name) => ({ name, slot: name })),
  );
  if (hasDetail) {
    const currentTrend = parentBuilder.importAnalysisResult(
      childQualification.plan,
      "overview-trend",
      [
        { field: "bucket" },
        { field: "views" },
        { field: "visitors" },
        { field: "sessions" },
        { field: "bounces" },
        { field: "totalDuration" },
        { field: "durationViews" },
      ],
    );
    parentBuilder.output(
      "overview-trend",
      currentTrend,
      [
        "bucket",
        "views",
        "visitors",
        "sessions",
        "bounces",
        "totalDuration",
        "durationViews",
      ].map((name) => ({ name, slot: name })),
    );
  }
  const cohort = parentBuilder.importAnalysisResult(
    childQualification.plan,
    OVERVIEW_CURRENT_COHORT_OUTPUT,
    [{ field: "siteId" }, { field: "entityId" }],
  );
  const controlsChild = childQualification.plan.outputs.find(
    (output) => output.id === OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!controlsChild)
    throw new Error("overview_previous_qualification_controls_missing");
  const controls = parentBuilder.importAnalysisResult(
    childQualification.plan,
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    controlsChild.fields.map(({ name }) => ({ field: name })),
  );
  parentBuilder.output(
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    controls,
    controlsChild.fields.map(({ name }) => ({ name, slot: name })),
  );

  const selection = previousSelection({
    siteId: input.siteId,
    currentTime: input.queryTime,
    previousTime: input.configuration.previousTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    selectionSubject: parentBuilder.context.subject,
  });
  const needsTrend = hasDetail;
  const rawPages = parentBuilder.source("page", {
    temporalDomain: "candidate",
    attributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      ...(needsTrend ? ["page.report.startedAt"] : []),
      "page.report.durationMs",
    ],
    relationships: ["page.session", "page.visitor"],
    selection,
  });
  const rawEvents = parentBuilder.source("event", {
    temporalDomain: "candidate",
    attributes: [
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      ...(needsTrend ? ["event.report.occurredAt"] : []),
    ],
    relationships: ["event.session", "event.visitor"],
    selection,
  });
  const siteCohort = parentBuilder.filter(
    cohort,
    parentBuilder.compare(
      "eq",
      parentBuilder.slot(cohort, "siteId"),
      parentBuilder.literal(input.siteId, STRING),
    ),
  );
  const ownerAttribute =
    input.count.scope === "session" ? "sessionId" : "visitorId";
  const ownerEventAttribute =
    ownerAttribute === "sessionId" ? "ownerSessionId" : "ownerVisitorId";
  const pages = parentBuilder.semiJoin(rawPages, siteCohort, [
    {
      left: `attribute:page.report.${ownerAttribute}`,
      right: "entityId",
    },
  ]);
  const events = parentBuilder.semiJoin(rawEvents, siteCohort, [
    {
      left: `attribute:event.report.${ownerEventAttribute}`,
      right: "entityId",
    },
  ]);
  appendOverviewAggregateReport(parentBuilder, {
    pages,
    events,
    scoped: true,
    outputId: "overview-previous-aggregate",
  });
  const plan = parentBuilder.finish();
  const reportOutputIds = [
    "overview-current-aggregate",
    "overview-previous-aggregate",
    ...(hasDetail ? ["overview-trend"] : []),
  ];
  const reportSourceRelations: readonly EventQualificationReportSource[] =
    Object.freeze([
      Object.freeze({ relationId: rawPages.id, entity: "page" }),
      Object.freeze({ relationId: rawEvents.id, entity: "event" }),
    ]);
  return Object.freeze({
    plan,
    childQualification,
    primaryReportSourceRelationId: rawPages.id,
    reportSourceRelations,
    reportOutputIds: Object.freeze(reportOutputIds),
    controlOutputId: OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
  });
}
