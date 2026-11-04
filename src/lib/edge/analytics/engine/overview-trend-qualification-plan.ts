import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendOverviewAggregateReport } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { appendQualifiedOverviewReportSource } from "@/lib/edge/analytics/engine/overview-report-source";
import { appendOverviewTrendReport } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT =
  "overview-trend-qualification-controls";
export const OVERVIEW_CURRENT_COHORT_OUTPUT = "overview-current-cohort";

export type OverviewTrendQualificationConfiguration =
  | { readonly kind: "aggregate" }
  | { readonly kind: "trend"; readonly interval: CalendarGranularity }
  | {
      readonly kind: "overview-with-detail";
      readonly interval: CalendarGranularity;
    }
  | {
      readonly kind: "overview-with-previous";
      readonly previousTime: QueryTime;
    }
  | {
      readonly kind: "overview-with-previous-and-detail";
      readonly previousTime: QueryTime;
      readonly interval: CalendarGranularity;
    };

export type LegacyOverviewTrendQualificationConfiguration = Extract<
  OverviewTrendQualificationConfiguration,
  { readonly kind: "aggregate" | "trend" | "overview-with-detail" }
>;

export type OverviewTrendQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly string[];
};

export function buildOverviewTrendQualificationPlan(input: {
  readonly semanticOperation: "overview" | "trend";
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly configuration: LegacyOverviewTrendQualificationConfiguration;
  readonly includeCurrentCohort?: boolean;
}): OverviewTrendQualificationPlan {
  const needsAggregate = input.configuration.kind !== "trend";
  const needsTrend = input.configuration.kind !== "aggregate";
  const source = appendQualifiedOverviewReportSource({
    semanticOperation: input.semanticOperation,
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    pageAttributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      ...(needsTrend ? ["page.report.startedAt"] : []),
      "page.report.durationMs",
    ],
    pageRelationships: ["page.session", "page.visitor"],
    eventAttributes: [
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      ...(needsTrend ? ["event.report.occurredAt"] : []),
    ],
    eventRelationships: ["event.session", "event.visitor"],
  });

  const reportOutputIds: string[] = [];
  if (needsAggregate) {
    appendOverviewAggregateReport(source.builder, {
      pages: source.pages,
      events: source.events,
      scoped: true,
    });
    reportOutputIds.push("overview-aggregate");
  }
  if (needsTrend) {
    if (!input.configuration.interval)
      throw new Error("overview_trend_qualification_interval_missing");
    appendOverviewTrendReport(source.builder, {
      pages: source.pages,
      events: source.events,
      scoped: true,
      interval: input.configuration.interval,
    });
    reportOutputIds.push("overview-trend");
  }
  if (input.includeCurrentCohort) {
    source.builder.output(
      OVERVIEW_CURRENT_COHORT_OUTPUT,
      source.qualification.matches,
      [
        { name: "siteId", slot: "siteId" },
        { name: "entityId", slot: "entityId" },
      ],
    );
    reportOutputIds.push(OVERVIEW_CURRENT_COHORT_OUTPUT);
  }

  source.builder.output(
    OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    Object.keys(source.qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  const plan = source.builder.finish();
  return {
    plan,
    primaryReportSourceRelationId: source.reportSourceRelations[0]!.relationId,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.freeze(reportOutputIds),
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}
