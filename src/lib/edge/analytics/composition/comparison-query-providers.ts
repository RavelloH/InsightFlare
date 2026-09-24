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
      if (!report.ok || !query.interval) return { value: report };

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
      if (!trend.ok) return { value: trend };

      return {
        value: {
          ok: true as const,
          data: { ...report.data, trend: trend.data },
          meta: {
            ...report.meta,
            source:
              report.meta.source === trend.meta.source
                ? report.meta.source
                : "mixed",
            approximateVisitors:
              report.meta.approximateVisitors || trend.meta.approximateVisitors,
          },
        },
      };
    }),
  );

  registry.register(
    "comparison-breakdown",
    typedQueryProviderFor("comparison-breakdown", async (input, execution) => ({
      value: await executeComparisonBreakdown(
        input,
        runtime.providers.breakdown,
        execution?.signal,
      ),
    })),
  );
}
