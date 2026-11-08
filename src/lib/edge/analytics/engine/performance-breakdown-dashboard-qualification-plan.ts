import type { SitePerformanceBreakdownDimension } from "@/lib/edge/analytics/contract/performance-dimensions";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  Interval,
  PerformanceMetricKey,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  appendPerformanceCountriesReport,
  appendPerformanceDashboardReport,
  appendPerformanceRoutesReport,
  PERFORMANCE_METRICS,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT =
  "performance-breakdown-dashboard-qualification-controls";

export type PerformanceBreakdownDashboardQualificationMode =
  | {
      readonly mode: "breakdown";
      readonly dimension: SitePerformanceBreakdownDimension;
      readonly metric: PerformanceMetricKey;
      readonly limit: number;
    }
  | {
      readonly mode: "dashboard";
      readonly interval: Interval;
      readonly routeLimit: number;
    };

export type PerformanceBreakdownDashboardQualificationPlan =
  AnalyticsQualificationPlan<"session" | "visitor" | "event"> & {
    readonly mode: PerformanceBreakdownDashboardQualificationMode["mode"];
    readonly reportOutputIds: readonly string[];
  };

function attributesFor(
  mode: PerformanceBreakdownDashboardQualificationMode,
): readonly SemanticAttributeId[] {
  const attributes: SemanticAttributeId[] = [
    "page.report.sessionId",
    "page.report.visitorId",
    ...PERFORMANCE_METRICS.map(
      ({ attribute }) => ("page.report." + attribute) as SemanticAttributeId,
    ),
  ];
  if (mode.mode === "dashboard")
    return [
      ...attributes,
      "page.report.startedAt",
      "page.report.pathname",
      "page.report.country",
    ];
  return mode.dimension === "page.path"
    ? [...attributes, "page.report.pathname"]
    : [...attributes, "page.report.country"];
}

export function buildPerformanceBreakdownDashboardQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
  readonly mode: PerformanceBreakdownDashboardQualificationMode;
}): PerformanceBreakdownDashboardQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "performance",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : (input.filterMode ?? "split-only"),
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [],
    additionalAttributes: attributesFor(input.mode),
  });
  const { builder, qualification, qualifiedPages } = source;
  const reportOutputIds =
    input.mode.mode === "dashboard"
      ? appendPerformanceDashboardReport(builder, qualifiedPages, {
          interval: input.mode.interval,
          routeLimit: input.mode.routeLimit,
        })
      : input.mode.dimension === "page.path"
        ? appendPerformanceRoutesReport(
            builder,
            qualifiedPages,
            input.mode.limit,
          )
        : appendPerformanceCountriesReport(builder, qualifiedPages);
  builder.output(
    PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  return {
    plan: builder.finish(),
    mode: input.mode.mode,
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId:
      PERFORMANCE_BREAKDOWN_DASHBOARD_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds,
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
