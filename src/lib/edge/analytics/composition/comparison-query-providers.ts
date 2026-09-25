import type { ComparisonRuntime } from "@/lib/edge/analytics/application/comparison-runtime";
import {
  type AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import type { ComparisonTrendQuery } from "@/lib/edge/analytics/contract";
import {
  executeComparison,
  executeComparisonBreakdown,
  executeComparisonTrend,
} from "@/lib/edge/analytics/contract/comparison";

/** Register comparison operations beside the site's or team's canonical queries. */
export function registerComparisonQueryProviders(
  registry: AnalyticsProviderRegistry,
  runtime: ComparisonRuntime,
): void {
  registry.register(
    "comparison",
    typedQueryProviderFor("comparison", async (query, execution) => {
      const report = await executeComparison(
        query,
        runtime.providers.overview,
        execution?.signal,
      );
      if (!query.interval) return report;

      const trendQuery: ComparisonTrendQuery = {
        ...query,
        interval: query.interval,
        trendMetrics: query.trendMetrics ?? query.metrics,
      };
      const trend = await executeComparisonTrend(
        trendQuery,
        runtime.providers.trend,
        execution?.signal,
      );

      return {
        value: {
          ...report.value,
          trend: trend.value,
        },
        source: report.source === trend.source ? report.source : "mixed",
        approximateVisitors:
          report.approximateVisitors || trend.approximateVisitors,
      };
    }),
  );

  registry.register(
    "comparison-breakdown",
    typedQueryProviderFor("comparison-breakdown", async (input, execution) => {
      return executeComparisonBreakdown(
        input,
        runtime.providers.breakdown,
        execution?.signal,
      );
    }),
  );
}
