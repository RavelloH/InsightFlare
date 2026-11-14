import type { MetricSummaryItem } from "@insightflare/ui/metric-summary-grid";
import {
  RiCalendarLine,
  RiGroupLine,
  RiPercentLine,
  RiRepeat2Line,
} from "@remixicon/react";

import { numberFormat, percentFormat } from "../charts/chart-format";
import {
  formatRetentionChange,
  retentionComparisonChange,
  type RetentionLabels,
  type RetentionViewModel,
} from "./retention-model";

export function createRetentionMetricItems({
  locale,
  labels,
  viewModel,
  comparisonViewModel,
  comparisonLabel,
  loading = false,
}: {
  locale: string;
  labels: RetentionLabels;
  viewModel: RetentionViewModel;
  comparisonViewModel?: RetentionViewModel | null;
  comparisonLabel: string;
  loading?: boolean;
}): MetricSummaryItem[] {
  const { summary } = viewModel;
  const comparisonSummary = comparisonViewModel?.summary;
  const item = (
    id: string,
    icon: MetricSummaryItem["icon"],
    label: string,
    value: string,
    detail: string,
    current: number | null,
    previous: number | null | undefined,
  ): MetricSummaryItem => {
    const comparisonChange =
      previous === undefined
        ? undefined
        : retentionComparisonChange(current, previous);
    const comparisonValue =
      previous === undefined || previous === null
        ? "--"
        : id === "period-one" || id === "average-return"
          ? percentFormat(locale, previous)
          : numberFormat(locale, previous);
    return {
      id,
      icon,
      label,
      value,
      detail:
        previous === undefined
          ? detail
          : `${comparisonLabel}: ${comparisonValue}`,
      change:
        comparisonChange === undefined || comparisonChange === null
          ? undefined
          : {
              value: formatRetentionChange(comparisonChange) ?? "",
              direction: comparisonChange >= 0 ? "up" : "down",
              tone: comparisonChange >= 0 ? "positive" : "negative",
            },
      loading,
    };
  };

  return [
    item(
      "cohorts",
      <RiCalendarLine />,
      labels.cohortsMetric,
      numberFormat(locale, summary.cohortCount),
      `${numberFormat(locale, viewModel.columns.length)} ${labels.periodsAnalyzed}`,
      summary.cohortCount,
      comparisonSummary?.cohortCount,
    ),
    item(
      "visitors",
      <RiGroupLine />,
      labels.visitorsMetric,
      numberFormat(locale, summary.totalVisitors),
      labels.cohortDetail,
      summary.totalVisitors,
      comparisonSummary?.totalVisitors,
    ),
    item(
      "period-one",
      <RiPercentLine />,
      labels.periodOneMetric,
      summary.periodOneRate === null
        ? "--"
        : percentFormat(locale, summary.periodOneRate),
      summary.periodOneBase > 0
        ? `${numberFormat(locale, summary.periodOneBase)} ${labels.eligibleVisitors}`
        : labels.noEligibleCohorts,
      summary.periodOneRate,
      comparisonSummary?.periodOneRate,
    ),
    item(
      "average-return",
      <RiRepeat2Line />,
      labels.averageReturnMetric,
      summary.averageReturnRate === null
        ? "--"
        : percentFormat(locale, summary.averageReturnRate),
      summary.strongestCohort
        ? `${labels.strongestCohortMetric}: ${summary.strongestCohort.label} ${percentFormat(locale, summary.strongestCohort.rate)}`
        : labels.noEligibleCohorts,
      summary.averageReturnRate,
      comparisonSummary?.averageReturnRate,
    ),
  ];
}
