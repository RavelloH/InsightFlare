import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  appendReferrersPageReport,
  appendReferrerSummaryReport,
  type ReferrerAggregateCursor,
  type ReferrerPageSortKey,
  REFERRERS_PAGE_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const REFERRERS_QUALIFICATION_CONTROL_OUTPUT =
  "referrers-qualification-controls";

export type ReferrersQualificationConfiguration =
  | {
      readonly kind: "summary";
      readonly topN: number;
    }
  | {
      readonly kind: "page";
      readonly limit: number;
      readonly includeFullUrl: boolean;
      readonly search?: string;
      readonly sortBy: ReferrerPageSortKey;
      readonly sortDirection: "asc" | "desc";
      readonly cursor: ReferrerAggregateCursor | null;
    };

export type ReferrersQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly string[];
};

interface ReferrersQualificationPlanBase {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
}

/** Composes Count controls with the qualified Page bag and the real report. */
export function buildReferrersQualificationPlan(
  input: ReferrersQualificationPlanBase & {
    readonly configuration: ReferrersQualificationConfiguration;
  },
): ReferrersQualificationPlan {
  const summary = input.configuration.kind === "summary";
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "referrers",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: "allow-whole-filter",
    scopePlan: input.scopePlan,
    count: input.count,
    selections: [],
    additionalAttributes: summary
      ? ["page.report.referrerHost", "page.report.referrerUrl"]
      : [
          "page.report.referrerHost",
          "page.report.referrerUrl",
          "page.report.sessionId",
          "page.report.visitorId",
        ],
  });
  const { builder, qualification, qualifiedPages } = source;
  const reportOutputIds = summary
    ? ["referrer-summary", "referrer-top-sources"]
    : [REFERRERS_PAGE_REPORT_OUTPUT];
  if (input.configuration.kind === "summary") {
    appendReferrerSummaryReport(builder, qualifiedPages, {
      topN: input.configuration.topN,
    });
  } else {
    appendReferrersPageReport(builder, qualifiedPages, {
      limit: input.configuration.limit,
      includeFullUrl: input.configuration.includeFullUrl,
      ...(input.configuration.search !== undefined
        ? { search: input.configuration.search }
        : {}),
      sortBy: input.configuration.sortBy,
      sortDirection: input.configuration.sortDirection,
      cursor: input.configuration.cursor,
    });
  }
  builder.output(
    REFERRERS_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  const plan = builder.finish();
  return {
    plan,
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: REFERRERS_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds,
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
  };
}
