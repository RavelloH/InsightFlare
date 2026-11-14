import type { RetentionLabels } from "@insightflare/product-ui/retention";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildRetentionLabels(
  messages: Pick<AppMessages, "retention" | "dashboardHeader">,
): RetentionLabels {
  const { retention } = messages;
  return {
    periodZero: retention.periodZero,
    periodLabel: retention.periodLabel,
    cohortDate: retention.cohortDate,
    cohortSize: retention.cohortSize,
    matrixTitle: retention.matrixTitle,
    matrixSubtitle: retention.matrixSubtitle,
    legendLow: retention.legendLow,
    legendHigh: retention.legendHigh,
    overallRetention: retention.overallRetention,
    sizeDetail: retention.sizeDetail,
    visitorsDetail: retention.visitorsDetail,
    rateDetail: retention.rateDetail,
    unavailableCell: retention.unavailableCell,
    compareCurrentPeriod: messages.dashboardHeader.compareCurrentPeriod,
    cohortsMetric: retention.cohortsMetric,
    visitorsMetric: retention.visitorsMetric,
    periodOneMetric: retention.periodOneMetric,
    averageReturnMetric: retention.averageReturnMetric,
    strongestCohortMetric: retention.strongestCohortMetric,
    periodsAnalyzed: retention.periodsAnalyzed,
    cohortDetail: retention.cohortDetail,
    eligibleVisitors: retention.eligibleVisitors,
    noEligibleCohorts: retention.noEligibleCohorts,
  };
}
