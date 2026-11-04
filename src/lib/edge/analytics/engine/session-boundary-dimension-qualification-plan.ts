import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type {
  AnalyticsQualificationPlan,
  EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  appendPageDimensionQualificationSource,
  PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  appendSessionPathComparisonRollup,
  appendSessionPathPageReport,
  appendSessionPathTopReport,
  SESSION_PATH_PAGE_REPORT_OUTPUT,
  SESSION_PATH_TOP_REPORT_OUTPUT,
  type SessionPathCursor,
  type SessionPathKind,
  type SessionPathSortKey,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SESSION_BOUNDARY_PAGE_ATTRIBUTES = [
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.startedAt",
  "page.report.localId",
  "page.report.pathname",
] as const satisfies readonly SemanticAttributeId[];

export type SessionBoundaryDimensionQualificationPlan =
  AnalyticsQualificationPlan & {
    readonly reportOutputIds: readonly [typeof SESSION_PATH_TOP_REPORT_OUTPUT];
  };

export type SessionBoundaryOverviewPageQualificationPlan =
  AnalyticsQualificationPlan & {
    readonly reportOutputIds: readonly [typeof SESSION_PATH_PAGE_REPORT_OUTPUT];
  };

export type SessionBoundaryComparisonQualificationPlan =
  AnalyticsQualificationPlan;

export function buildSessionBoundaryDimensionQualificationPlan(input: {
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
}): SessionBoundaryDimensionQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.filterMode ?? "split-only",
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: SESSION_BOUNDARY_PAGE_ATTRIBUTES,
  });
  const { builder, qualification, qualifiedPages } = source;
  appendSessionPathTopReport(builder, qualifiedPages, input);
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  const reportSourceRelations: readonly EventQualificationReportSource[] =
    source.reportSourceRelations;
  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [SESSION_PATH_TOP_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations,
  };
}

export function buildSessionBoundaryOverviewPageQualificationPlan(input: {
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: SessionPathCursor | null;
  readonly semanticOperation?: "dimension" | "filter-values";
}): SessionBoundaryOverviewPageQualificationPlan {
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
    selections: [],
    additionalAttributes: SESSION_BOUNDARY_PAGE_ATTRIBUTES,
  });
  const { builder, qualification, qualifiedPages } = source;
  appendSessionPathPageReport(builder, qualifiedPages, input);
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  const reportSourceRelations: readonly EventQualificationReportSource[] =
    source.reportSourceRelations;
  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [SESSION_PATH_PAGE_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations,
  };
}

export function buildSessionBoundaryComparisonQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly kind: SessionPathKind;
  readonly reportOutputId: string;
  readonly controlsOutputId: string;
}): SessionBoundaryComparisonQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: SESSION_BOUNDARY_PAGE_ATTRIBUTES,
  });
  const { builder, qualification, qualifiedPages } = source;
  appendSessionPathComparisonRollup(
    builder,
    qualifiedPages,
    input.kind,
    input.reportOutputId,
  );
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
