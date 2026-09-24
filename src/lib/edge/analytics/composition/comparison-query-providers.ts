import type { ComparisonRuntime } from "@/lib/edge/analytics/application/comparison-runtime";
import {
  type AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import type {
  AnalyticsResult,
  ComparisonBreakdownQuery,
  ComparisonBreakdownResult,
  ComparisonMetricKey,
  ComparisonQuery,
  ComparisonResult,
  ComparisonTrendQuery,
  ComparisonTrendResult,
  QueryInput,
} from "@/lib/edge/analytics/contract";
import {
  executeComparison,
  executeComparisonBreakdown,
  executeComparisonTrend,
} from "@/lib/edge/analytics/contract/comparison";

type ComparisonExecutionQuery = ComparisonQuery & {
  readonly interval?: ComparisonTrendQuery["interval"];
  readonly trendMetrics?: readonly ComparisonMetricKey[];
};
type ComparisonReportResult = AnalyticsResult<
  ComparisonResult & { readonly trend?: ComparisonTrendResult }
>;

function comparisonQuery(input: QueryInput): ComparisonExecutionQuery {
  return input as ComparisonExecutionQuery;
}

/** Register comparison operations beside the site's or team's canonical queries. */
export function registerComparisonQueryProviders(
  registry: AnalyticsProviderRegistry,
  runtime: ComparisonRuntime,
): void {
  registry.register(
    "comparison",
    typedQueryProvider<ComparisonReportResult>(async (input, execution) => {
      const query = comparisonQuery(input!);
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
    typedQueryProvider<AnalyticsResult<ComparisonBreakdownResult>>(
      async (input, execution) => ({
        value: await executeComparisonBreakdown(
          input as ComparisonBreakdownQuery,
          runtime.providers.breakdown,
          execution?.signal,
        ),
      }),
    ),
  );
}
