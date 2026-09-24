import type { ComparisonProvider } from "@/lib/edge/analytics/contract/comparison";
import type {
  ComparisonBreakdownQuery,
  ComparisonQuery,
  ComparisonRawBreakdownResult,
  ComparisonRawMetrics,
  ComparisonRawTrendResult,
  ComparisonTrendQuery,
} from "@/lib/edge/analytics/contract/types";
export interface ComparisonProviderSet {
  readonly overview: ComparisonProvider<ComparisonRawMetrics, ComparisonQuery>;
  readonly trend: ComparisonProvider<
    ComparisonRawTrendResult,
    ComparisonTrendQuery
  >;
  readonly breakdown: ComparisonProvider<
    ComparisonRawBreakdownResult,
    ComparisonBreakdownQuery
  >;
}
/** Runtime ports needed by the API v1 comparison interface. */
export interface ComparisonRuntime {
  readonly providers: ComparisonProviderSet;
  readonly readSiteCount: () => Promise<number>;
}
