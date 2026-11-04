import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { appendComparisonDimensionRollup } from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  appendDimensionPageReport,
  DIMENSION_PAGE_REPORT_OUTPUT,
  type DimensionPageReportOptions,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import {
  buildPaginatedPageRows,
  type PageAggregateCursor,
} from "@/lib/edge/analytics/engine/page-report-plan";
import {
  appendPageTabOutputs,
  buildPageTabRows,
  PAGE_TAB_CARDS,
  PAGE_TAB_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import {
  appendPagesWithTabsOutputs,
  PAGES_WITH_TABS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import {
  appendQualifiedPageSource,
  type QualifiedPageSemanticOperation,
  type QualifiedSourceFilterMode,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT =
  "page-dimension-qualification-controls";
export const PAGES_AGGREGATE_REPORT_OUTPUT = "pages-aggregate-page";
export const PAGES_AGGREGATE_QUALIFICATION_CONTROL_OUTPUT =
  "pages-aggregate-qualification-controls";
export const PAGES_TABS_QUALIFICATION_CONTROL_OUTPUT =
  "pages-tabs-qualification-controls";

export type PagesTabsQualificationConfiguration =
  "tabs-only" | "pages-with-tabs";

export type PagesTabsQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly string[];
};

export type PageDimensionQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly [typeof DIMENSION_PAGE_REPORT_OUTPUT];
};

export type PagesAggregateQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly [typeof PAGES_AGGREGATE_REPORT_OUTPUT];
};

export { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/qualified-page-source";

export function appendPageDimensionQualificationSource(input: {
  readonly semanticOperation?: QualifiedPageSemanticOperation;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly selections: readonly PageDimensionSelection[];
  readonly additionalAttributes?: readonly SemanticAttributeId[];
}): {
  readonly builder: ReturnType<typeof appendQualifiedPageSource>["builder"];
  readonly qualification: ReturnType<
    typeof appendQualifiedPageSource
  >["qualification"];
  readonly pageSource: ReturnType<
    typeof appendQualifiedPageSource
  >["pageSource"];
  readonly qualifiedPages: LogicalRelationHandle;
  readonly reportSourceRelations: ReturnType<
    typeof appendQualifiedPageSource
  >["reportSourceRelations"];
} {
  return appendQualifiedPageSource(input);
}

/** Combines Count controls with the real Page report Source and its page. */
export function buildPageDimensionQualificationPlan(input: {
  readonly semanticOperation?:
    "dimension" | "filter-values" | "channels" | "pages";
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly options: DimensionPageReportOptions & {
    readonly selection: PageDimensionSelection;
  };
}): PageDimensionQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    ...(input.semanticOperation
      ? { semanticOperation: input.semanticOperation }
      : {}),
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.filterMode ?? "split-only",
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [input.options.selection],
  });
  const { builder, qualification, qualifiedPages } = source;
  appendDimensionPageReport(builder, qualifiedPages, input.options);
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [DIMENSION_PAGE_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}

/** Builds the ordinary Pages aggregate page from the common qualified Page source. */
export function buildPagesAggregateQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor?: PageAggregateCursor | null;
}): PagesAggregateQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "pages",
    filterMode: "allow-whole-filter",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: [
      "page.report.pathname",
      "page.report.sessionId",
      ...(input.includeDetails
        ? (["page.report.queryString", "page.report.hash"] as const)
        : []),
    ],
  });
  const { builder, qualification, qualifiedPages } = source;
  const rows = buildPaginatedPageRows(builder, qualifiedPages, {
    limit: input.limit,
    includeDetails: input.includeDetails,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  builder.output(PAGES_AGGREGATE_REPORT_OUTPUT, rows, [
    { name: "pathname", slot: "pathname" },
    { name: "queryValue", slot: "query" },
    { name: "hashValue", slot: "hash" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
  ]);
  builder.output(
    PAGES_AGGREGATE_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGES_AGGREGATE_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [PAGES_AGGREGATE_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}

/** Builds one Count + qualified Page bag for tabs-only or paginated Pages+tabs. */
export function buildPagesTabsQualificationPlan(input: {
  readonly configuration: PagesTabsQualificationConfiguration;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor?: PageAggregateCursor | null;
}): PagesTabsQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "pages",
    filterMode: "allow-whole-filter",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    selections: PAGE_TAB_CARDS.map(({ selection }) => selection),
    additionalAttributes: [
      "page.report.pathname",
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.localId",
      ...(input.includeDetails
        ? (["page.report.queryString", "page.report.hash"] as const)
        : []),
    ],
  });
  const { builder, qualification, qualifiedPages } = source;
  const reportOutputIds =
    input.configuration === "tabs-only"
      ? PAGE_TAB_OUTPUT_IDS
      : PAGES_WITH_TABS_OUTPUT_IDS;
  if (input.configuration === "tabs-only") {
    const tabs = buildPageTabRows(
      builder as LogicalPlanBuilder,
      qualifiedPages,
      qualifiedPages,
      input.limit,
    );
    appendPageTabOutputs(builder as LogicalPlanBuilder, tabs);
  } else {
    appendPagesWithTabsOutputs(builder as LogicalPlanBuilder, {
      pages: qualifiedPages,
      boundaryPages: qualifiedPages,
      limit: input.limit,
      includeDetails: input.includeDetails,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }
  builder.output(
    PAGES_TABS_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGES_TABS_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds,
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}

/** Builds an unpaginated Page rollup and independent qualification controls. */
export function buildComparisonPageDimensionQualificationPlan(input: {
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly selection: PageDimensionSelection;
  readonly reportOutputId: string;
  readonly controlsOutputId: string;
}): AnalyticsQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.filterMode ?? "split-only",
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [input.selection],
  });
  const { builder, qualification, qualifiedPages } = source;
  const rollup = appendComparisonDimensionRollup(
    builder,
    qualifiedPages,
    input.selection,
  );
  builder.output(input.reportOutputId, rollup, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  builder.output(
    input.controlsOutputId,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: input.controlsOutputId,
    reportOutputIds: [input.reportOutputId],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}
