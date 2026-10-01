import type {
  GoalConversionProgressDisplay,
  GoalMetricDisplay,
} from "@insightflare/product-ui/goals";
import { GoalVisualization as GoalVisualizationView } from "@insightflare/product-ui/goals";

import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { GoalSummary } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function conversionRateChange(
  current?: GoalSummary["sessions"],
  comparison?: GoalSummary["sessions"],
): number | null {
  const currentRate = Number(current?.conversionRate);
  const comparisonRate = Number(comparison?.conversionRate);
  if (
    !Number.isFinite(currentRate) ||
    !Number.isFinite(comparisonRate) ||
    comparisonRate === 0
  ) {
    return null;
  }
  return ((currentRate - comparisonRate) / comparisonRate) * 100;
}

function transitionKey(
  metric: GoalSummary["sessions"] | undefined,
  loading: boolean,
): string {
  return loading
    ? "loading"
    : `${metric?.conversionRate ?? 0}:${metric?.converted ?? 0}:${metric?.total ?? 0}`;
}

function metricDisplay(
  metric: GoalSummary["sessions"] | undefined,
  comparisonMetric: GoalSummary["sessions"] | undefined,
  locale: Locale,
  label: string,
  loading: boolean,
  comparisonLoading: boolean,
): GoalMetricDisplay {
  const change = conversionRateChange(metric, comparisonMetric);
  const comparison =
    comparisonLoading || comparisonMetric
      ? {
          loading: comparisonLoading,
          transitionKey: comparisonLoading
            ? "comparison-loading"
            : `${comparisonMetric?.conversionRate ?? 0}:${comparisonMetric?.converted ?? 0}:${comparisonMetric?.total ?? 0}`,
          change:
            !comparisonLoading && comparisonMetric && change !== null
              ? {
                  direction: change >= 0 ? ("up" as const) : ("down" as const),
                  text: formatChangeRate(change) ?? "",
                }
              : null,
        }
      : null;

  return {
    label,
    conversionRate: percentFormat(locale, metric?.conversionRate ?? 0),
    convertedCount: numberFormat(locale, metric?.converted ?? 0),
    totalCount: numberFormat(locale, metric?.total ?? 0),
    loading,
    transitionKey: transitionKey(metric, loading),
    comparison,
  };
}

function normalizedProgress(metric: GoalSummary["visitors"] | undefined) {
  const rate = Number.isFinite(metric?.conversionRate)
    ? Math.min(1, Math.max(0, metric?.conversionRate ?? 0))
    : 0;
  return { value: rate * 100, valueTextRate: rate };
}

export function GoalVisualizationAdapter({
  summary,
  comparisonSummary,
  locale,
  labels,
  loading = false,
  comparisonLoading = false,
}: {
  readonly summary?: GoalSummary;
  readonly comparisonSummary?: GoalSummary;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly loading?: boolean;
  readonly comparisonLoading?: boolean;
}) {
  const visitorSummary = summary?.visitors;
  const comparisonVisitorSummary = comparisonSummary?.visitors;
  const visitorProgress = normalizedProgress(visitorSummary);
  const comparisonProgress = normalizedProgress(comparisonVisitorSummary);
  const progressComparisonVisible =
    comparisonLoading || Boolean(comparisonVisitorSummary);

  const visitorConversion: GoalConversionProgressDisplay = {
    label: `${labels.visitors} ${labels.conversion}`,
    value: visitorProgress.value,
    valueText: percentFormat(locale, visitorProgress.valueTextRate),
    loading,
    transitionKey: transitionKey(visitorSummary, loading),
    comparison: progressComparisonVisible
      ? {
          label: `${labels.visitors} ${labels.conversion} comparison`,
          value: comparisonProgress.value,
          valueText: percentFormat(locale, comparisonProgress.valueTextRate),
          loading: comparisonLoading,
          transitionKey: comparisonLoading
            ? "comparison-loading"
            : String(comparisonProgress.valueTextRate),
        }
      : null,
  };

  return (
    <GoalVisualizationView
      visitors={metricDisplay(
        summary?.visitors,
        comparisonSummary?.visitors,
        locale,
        labels.visitors,
        loading,
        comparisonLoading,
      )}
      sessions={metricDisplay(
        summary?.sessions,
        comparisonSummary?.sessions,
        locale,
        labels.sessions,
        loading,
        comparisonLoading,
      )}
      visitorConversion={visitorConversion}
    />
  );
}
