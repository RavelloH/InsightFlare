import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type {
  AnalyticsQualificationPlan,
  EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import {
  appendPageCardTitleRows,
  appendPageCardTrendRows,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import {
  appendPageCardMetricsPage,
  appendPageCardMetricsRollup,
  PAGE_CARD_METRICS_OUTPUT_FIELDS,
  type PageCardMetricsCursor,
  type PageCardMetricSort,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { resolveQualifiedSourceFilters } from "@/lib/edge/analytics/engine/qualified-page-source";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

const PAGE_ATTRIBUTES = [
  "attribute:page.report.pathname",
  "attribute:page.report.sessionId",
  "attribute:page.report.visitorId",
  "attribute:page.report.durationMs",
] as const;

export const PAGES_DASHBOARD_QUALIFICATION_OUTPUTS = {
  current: "pages-dashboard-qualified-current",
  previous: "pages-dashboard-qualified-previous",
  titles: "pages-dashboard-qualified-titles",
  trend: "pages-dashboard-qualified-trend",
  currentPaths: "pages-dashboard-qualified-current-paths",
  currentCohort: "pages-dashboard-qualified-current-cohort",
  controls: "pages-dashboard-qualified-controls",
} as const;

const CHILD_OUTPUTS = {
  currentRows: "pages-dashboard-child-current-rows",
  currentPaths: "pages-dashboard-child-current-paths",
  titles: "pages-dashboard-child-titles",
  trend: "pages-dashboard-child-trend",
  cohort: "pages-dashboard-child-current-cohort",
  controls: "pages-dashboard-child-controls",
} as const;

export const PAGES_DASHBOARD_CURRENT_OUTPUT_FIELDS = [
  ...PAGE_CARD_METRICS_OUTPUT_FIELDS,
  "rowOrder",
] as const;

export const PAGES_DASHBOARD_TITLE_OUTPUT_FIELDS = [
  "pathname",
  "title",
  "views",
  "rowOrder",
] as const;

export const PAGES_DASHBOARD_TREND_OUTPUT_FIELDS = [
  "pathname",
  "bucket",
  "views",
  "visitors",
] as const;

export const PAGES_DASHBOARD_REPORT_FIELDS = [
  "pathname",
  "rowOrder",
  "bucket",
  "title",
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
  "previousViews",
  "previousSessions",
  "previousVisitors",
  "previousBounces",
  "previousTotalDuration",
  "previousDurationViews",
] as const;

export interface PagesDashboardQualificationPlan extends AnalyticsQualificationPlan {
  readonly childQualification: AnalyticsQualificationPlan;
  readonly reportOutputIds: readonly [
    typeof PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
    typeof PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
    typeof PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
  ];
  readonly previousTime: QueryTime;
}

export interface PagesDashboardQualificationInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly interval: CalendarGranularity;
  readonly limit: number;
  readonly sort?: PageCardMetricSort;
  readonly direction?: "asc" | "desc";
  readonly cursor?: PageCardMetricsCursor | null;
  readonly search?: string;
}

interface PagesDashboardChildQualification extends AnalyticsQualificationPlan {
  readonly reportOutputIds: readonly string[];
}

function previousQueryTime(queryTime: QueryTime): QueryTime {
  const duration = queryTime.range.endExclusiveMs - queryTime.range.startMs;
  const startMs = Math.max(queryTime.range.startMs - duration, 0);
  const endExclusiveMs = queryTime.range.startMs;
  if (startMs >= endExclusiveMs)
    throw new Error("pages_dashboard_previous_window_empty");
  return createQueryTime(
    startMs,
    endExclusiveMs,
    queryTime.reportingTimeZone,
    queryTime.capturedAtMs,
  );
}

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

function metricSortOrder(input: {
  readonly sort: PageCardMetricSort;
  readonly direction: "asc" | "desc";
}) {
  const secondary =
    input.sort === "views" || input.sort === "bounceRate"
      ? "sessions"
      : "views";
  return [
    { slot: input.sort, direction: input.direction, nulls: "last" as const },
    { slot: secondary, direction: input.direction, nulls: "last" as const },
    { slot: "pathname", direction: "asc" as const, nulls: "first" as const },
  ];
}

function buildCurrentChild(
  input: PagesDashboardQualificationInput,
): PagesDashboardChildQualification {
  if (!Number.isInteger(input.limit) || input.limit < 0)
    throw new Error("pages_dashboard_invalid_limit");
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "pages-dashboard",
    preparedTimePolicy: "reader-window-v1",
    filterMode: "allow-whole-filter",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: [
      "page.report.pathname",
      "page.report.title",
      "page.report.startedAt",
      "page.report.durationMs",
    ],
  });
  const { builder, qualification, pageSource, qualifiedPages } = source;
  const metrics = appendPageCardMetricsRollup({
    builder,
    pages: qualifiedPages,
  });
  const sortedCurrentRows = appendPageCardMetricsPage(builder, metrics, {
    limit: input.limit + 1,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.search ? { search: input.search } : {}),
    sort: input.sort ?? "views",
    direction: input.direction ?? "desc",
  });
  const orderedCurrentRows = builder.rankedMembers(sortedCurrentRows, {
    groups: [],
    order: metricSortOrder({
      sort: input.sort ?? "views",
      direction: input.direction ?? "desc",
    }),
  });
  const currentOutput = builder.project(
    orderedCurrentRows,
    Object.fromEntries([
      ...PAGE_CARD_METRICS_OUTPUT_FIELDS.map((field) => [
        field,
        builder.slot(orderedCurrentRows, field),
      ]),
      ["rowOrder", builder.slot(orderedCurrentRows, "rank")],
    ]),
  );
  builder.output(
    CHILD_OUTPUTS.currentRows,
    currentOutput,
    PAGES_DASHBOARD_CURRENT_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );

  const actualCurrentRows = builder.filter(
    orderedCurrentRows,
    builder.compare(
      "lte",
      builder.slot(orderedCurrentRows, "rank"),
      builder.literal(input.limit, NUMBER),
    ),
  );
  const normalizedCurrentPaths = builder.project(actualCurrentRows, {
    pathname: builder.normalizeString(
      builder.slot(actualCurrentRows, "pathname"),
      "trim",
    ),
  });
  const nonemptyCurrentPaths = builder.filter(
    normalizedCurrentPaths,
    builder.compare(
      "neq",
      builder.slot(normalizedCurrentPaths, "pathname"),
      builder.literal("", STRING),
    ),
  );
  const selectedCurrentPaths = builder.distinct(
    nonemptyCurrentPaths,
    [{ input: "pathname" }],
    { excludeNull: true },
  );
  builder.output(CHILD_OUTPUTS.currentPaths, selectedCurrentPaths, [
    { name: "pathname", slot: "pathname" },
  ]);

  const detailPages = builder.project(qualifiedPages, {
    "attribute:page.report.pathname": builder.slot(
      qualifiedPages,
      "attribute:page.report.pathname",
    ),
    "attribute:page.report.title": builder.slot(
      qualifiedPages,
      "attribute:page.report.title",
    ),
    "attribute:page.report.startedAt": builder.slot(
      qualifiedPages,
      "attribute:page.report.startedAt",
    ),
    "attribute:page.report.visitorId": builder.slot(
      qualifiedPages,
      "attribute:page.report.visitorId",
    ),
    normalizedPathname: builder.normalizeString(
      builder.slot(qualifiedPages, "attribute:page.report.pathname"),
      "trim-ascii-space",
    ),
  });
  const selectedDetailPages = builder.semiJoin(
    detailPages,
    selectedCurrentPaths,
    [{ left: "normalizedPathname", right: "pathname" }],
  );
  const titleRows = appendPageCardTitleRows(
    builder,
    selectedDetailPages,
    selectedDetailPages,
    3,
  );
  builder.output(CHILD_OUTPUTS.titles, titleRows, [
    { name: "pathname", slot: "pathname" },
    { name: "title", slot: "title" },
    { name: "views", slot: "views" },
    { name: "rank", slot: "rank" },
  ]);
  const trendRows = appendPageCardTrendRows(
    builder,
    selectedDetailPages,
    selectedDetailPages,
    input.interval,
  );
  builder.output(CHILD_OUTPUTS.trend, trendRows, [
    { name: "pathname", slot: "pathname" },
    { name: "bucket", slot: "bucket" },
    { name: "views", slot: "views" },
    { name: "visitors", slot: "visitors" },
  ]);

  builder.output(CHILD_OUTPUTS.cohort, qualification.matches, [
    { name: "siteId", slot: "siteId" },
    { name: "entityId", slot: "entityId" },
  ]);
  builder.output(
    CHILD_OUTPUTS.controls,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  const plan = builder.finish();
  return {
    plan,
    primaryReportSourceRelationId: pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: CHILD_OUTPUTS.controls,
    reportOutputIds: [
      CHILD_OUTPUTS.currentRows,
      CHILD_OUTPUTS.currentPaths,
      CHILD_OUTPUTS.titles,
      CHILD_OUTPUTS.trend,
      CHILD_OUTPUTS.cohort,
    ],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}

function previousPageSelection(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly previousTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly subject: PagesDashboardQualificationPlan["plan"]["context"]["subject"];
}): SemanticScopedSourceSelection {
  const metadata = scopedFilterMetadata(input.filters);
  if (
    !metadata ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    metadata.resolvedScope !== input.scopePlan.scope ||
    metadata.plan !== input.scopePlan ||
    !sameQueryTime(metadata.time, input.queryTime)
  )
    throw new Error("pages_dashboard_qualification_request_context_mismatch");
  const filterResolution = resolveQualifiedSourceFilters(
    input.filters,
    "allow-whole-filter",
  );
  if (filterResolution.kind === "unsupported")
    throw new Error("pages_dashboard_native_filter_split_unsupported");
  const nativePlan = createScopedFilterPlan(
    "pages-dashboard",
    filterResolution.nativeFilters,
    input.scopePlan.scope,
  );
  const previousTime = semanticTemporalDomainsFromQueryTime(input.previousTime);
  if (!nativePlan) {
    if (filterResolution.nativeFilters.root !== null)
      throw new Error("pages_dashboard_native_scope_plan_missing");
    return createSemanticScopedSourceSelection({
      profile: "direct-page-analytics-v1",
      filters: filterResolution.nativeFilters,
      subject: input.subject,
      time: previousTime,
    });
  }
  if (nativePlan.scope !== input.scopePlan.scope)
    throw new Error("pages_dashboard_native_scope_mismatch");
  const nativeFilters = attachScopedFilterMetadata(
    filterResolution.nativeFilters,
    {
      requestedScope: input.scopePlan.scope,
      resolvedScope: nativePlan.scope,
      plan: nativePlan,
      time: metadata.time,
      siteIds: metadata.siteIds,
    },
  );
  return createSemanticScopedSourceSelection({
    profile: "prepared-page-reader-window-v1",
    filters: nativeFilters,
    subject: input.subject,
    time: previousTime,
    expectedPlan: nativePlan,
    preparedPlanOperation: "pages-dashboard",
  });
}

function importChildOutput(
  builder: LogicalPlanBuilder,
  child: PagesDashboardChildQualification,
  outputId: string,
  fields: readonly string[],
): LogicalRelationHandle {
  return builder.importAnalysisResult(
    child.plan,
    outputId,
    fields.map((field) => ({ field })),
  );
}

function previousPageMetrics(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly currentRows: LogicalRelationHandle;
  readonly selectedPaths: LogicalRelationHandle;
}) {
  const { builder } = input;
  const currentRowCount = builder.aggregate(input.currentRows, {}, [
    { name: "rowCount", kind: "count-rows" },
  ]);
  const currentExists = builder.filter(
    currentRowCount,
    builder.compare(
      "gt",
      builder.slot(currentRowCount, "rowCount"),
      builder.literal(0, NUMBER),
    ),
  );
  const currentGate = builder.project(currentExists, {
    currentGate: builder.literal(1, NUMBER),
  });
  const pageRows = builder.project(input.pages, {
    ...Object.fromEntries(
      PAGE_ATTRIBUTES.map((name) => [name, builder.slot(input.pages, name)]),
    ),
    pathMatch: builder.normalizeString(
      builder.slot(input.pages, "attribute:page.report.pathname"),
      "trim-ascii-space",
    ),
    currentGate: builder.literal(1, NUMBER),
  });
  const currentPageRows = builder.join(pageRows, currentGate, [
    { left: "currentGate", right: "currentGate" },
  ]);
  const nonemptyPageRows = builder.filter(
    currentPageRows,
    builder.compare(
      "neq",
      builder.slot(currentPageRows, "pathMatch"),
      builder.literal("", STRING),
    ),
  );
  const matchingPathRows = builder.semiJoin(
    nonemptyPageRows,
    input.selectedPaths,
    [{ left: "pathMatch", right: "pathname" }],
  );
  const selectedPathCount = builder.aggregate(input.selectedPaths, {}, [
    { name: "pathCount", kind: "count-rows" },
  ]);
  const noSelectedPath = builder.filter(
    selectedPathCount,
    builder.compare(
      "eq",
      builder.slot(selectedPathCount, "pathCount"),
      builder.literal(0, NUMBER),
    ),
  );
  const noSelectedPathGate = builder.project(noSelectedPath, {
    noSelectedPathGate: builder.literal(1, NUMBER),
  });
  const allRowsWhenNoSelectedPath = builder.join(
    nonemptyPageRows,
    noSelectedPathGate,
    [{ left: "currentGate", right: "noSelectedPathGate" }],
  );
  const projectMetricAttributes = (rows: LogicalRelationHandle) =>
    builder.project(
      rows,
      Object.fromEntries(
        PAGE_ATTRIBUTES.map((name) => [name, builder.slot(rows, name)]),
      ),
    );
  const selectedMetricPages = projectMetricAttributes(matchingPathRows);
  const allMetricPages = projectMetricAttributes(allRowsWhenNoSelectedPath);
  const eligiblePages = builder.appendRows(
    [selectedMetricPages, allMetricPages],
    PAGE_ATTRIBUTES,
  );
  return appendPageCardMetricsRollup({ builder, pages: eligiblePages });
}

/** Build one current Count child and a parent that reuses its cohort for previous metrics. */
export function buildPagesDashboardQualificationPlan(
  input: PagesDashboardQualificationInput,
): PagesDashboardQualificationPlan {
  if (input.count.scope !== "session" && input.count.scope !== "visitor")
    throw new Error("pages_dashboard_count_scope_invalid");
  const childQualification = buildCurrentChild(input);
  const previousTime = previousQueryTime(input.queryTime);
  const builder = new LogicalPlanBuilder({
    ...childQualification.plan.context,
    time: semanticTemporalDomainsFromQueryTime(previousTime),
    originOperation: "pages-dashboard",
  });

  const currentRows = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.currentRows,
    PAGES_DASHBOARD_CURRENT_OUTPUT_FIELDS,
  );
  const selectedPaths = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.currentPaths,
    ["pathname"],
  );
  const titleRows = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.titles,
    ["pathname", "title", "views", "rank"],
  );
  const trendRows = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.trend,
    ["pathname", "bucket", "views", "visitors"],
  );
  const cohort = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.cohort,
    ["siteId", "entityId"],
  );
  const childControls = childQualification.plan.outputs.find(
    (output) => output.id === CHILD_OUTPUTS.controls,
  );
  if (!childControls) throw new Error("pages_dashboard_child_controls_missing");
  const controls = importChildOutput(
    builder,
    childQualification,
    CHILD_OUTPUTS.controls,
    childControls.fields.map(({ name }) => name),
  );
  builder.output(
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.controls,
    controls,
    childControls.fields.map(({ name }) => ({ name, slot: name })),
  );

  const sourceMetadata = scopedFilterMetadata(input.filters);
  if (!sourceMetadata)
    throw new Error("pages_dashboard_source_metadata_missing");
  const selection = previousPageSelection({
    siteId: input.siteId,
    queryTime: input.queryTime,
    previousTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    subject: builder.context.subject,
  });
  const rawPreviousPages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: [
      "page.report.pathname",
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.durationMs",
    ],
    relationships: ["page.session", "page.visitor"],
    selection,
  });
  const siteCohort = builder.filter(
    cohort,
    builder.compare(
      "eq",
      builder.slot(cohort, "siteId"),
      builder.literal(input.siteId, STRING),
    ),
  );
  const ownerAttribute =
    input.count.scope === "session" ? "sessionId" : "visitorId";
  const qualifiedPreviousPages = builder.semiJoin(
    rawPreviousPages,
    siteCohort,
    [
      {
        left: `attribute:page.report.${ownerAttribute}`,
        right: "entityId",
      },
    ],
  );
  const previousMetrics = previousPageMetrics({
    builder,
    pages: qualifiedPreviousPages,
    currentRows,
    selectedPaths,
  });
  const joinedCards = builder.join(
    currentRows,
    previousMetrics,
    [{ left: "pathname", right: "pathname" }],
    "left",
  );
  const zeroFor = (field: string) => {
    const type = builder.slot(joinedCards, field).type;
    if (type.kind !== "scalar")
      throw new Error("pages_dashboard_metric_zero_requires_scalar");
    return builder.literal(0, type);
  };
  const currentAndPreviousCards = builder.project(joinedCards, {
    pathname: builder.slot(joinedCards, "pathname"),
    rowOrder: builder.slot(joinedCards, "rowOrder"),
    views: builder.slot(joinedCards, "views"),
    sessions: builder.slot(joinedCards, "sessions"),
    visitors: builder.slot(joinedCards, "visitors"),
    bounces: builder.slot(joinedCards, "bounces"),
    totalDuration: builder.slot(joinedCards, "totalDuration"),
    durationViews: builder.slot(joinedCards, "durationViews"),
    previousViews: builder.coalesce(
      builder.slot(joinedCards, "right.views"),
      zeroFor("right.views"),
    ),
    previousSessions: builder.coalesce(
      builder.slot(joinedCards, "right.sessions"),
      zeroFor("right.sessions"),
    ),
    previousVisitors: builder.coalesce(
      builder.slot(joinedCards, "right.visitors"),
      zeroFor("right.visitors"),
    ),
    previousBounces: builder.coalesce(
      builder.slot(joinedCards, "right.bounces"),
      zeroFor("right.bounces"),
    ),
    previousTotalDuration: builder.coalesce(
      builder.slot(joinedCards, "right.totalDuration"),
      zeroFor("right.totalDuration"),
    ),
    previousDurationViews: builder.coalesce(
      builder.slot(joinedCards, "right.durationViews"),
      zeroFor("right.durationViews"),
    ),
  });
  builder.output(
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
    currentAndPreviousCards,
    PAGES_DASHBOARD_REPORT_FIELDS.filter(
      (name) => name !== "bucket" && name !== "title",
    ).map((name) => ({ name, slot: name })),
  );
  const titles = builder.project(titleRows, {
    pathname: builder.slot(titleRows, "pathname"),
    title: builder.slot(titleRows, "title"),
    views: builder.slot(titleRows, "views"),
    rowOrder: builder.slot(titleRows, "rank"),
  });
  builder.output(
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
    titles,
    PAGES_DASHBOARD_TITLE_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );
  builder.output(
    PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
    trendRows,
    PAGES_DASHBOARD_TREND_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );

  const plan = builder.finish();
  return {
    plan,
    childQualification,
    previousTime,
    primaryReportSourceRelationId: rawPreviousPages.id,
    matchesRelationId: childQualification.matchesRelationId,
    controlsRelationId: controls.id,
    groupedSummaryRelationId: childQualification.groupedSummaryRelationId,
    controlOutputId: PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.controls,
    reportOutputIds: [
      PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.current,
      PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.titles,
      PAGES_DASHBOARD_QUALIFICATION_OUTPUTS.trend,
    ],
    numericCompatibilityFields: childQualification.numericCompatibilityFields,
    scope: childQualification.scope,
    reportSourceRelations: [
      { relationId: rawPreviousPages.id, entity: "page" },
    ] satisfies readonly EventQualificationReportSource[],
  };
}
