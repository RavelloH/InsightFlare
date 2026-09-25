import { analyticsOperationRegistry } from "@/lib/edge/analytics/application/operation-registry";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import type { AnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  type CanonicalQuery,
  executeOverview,
  executeTrend,
  type OverviewQuery,
  type OverviewReader,
  type QueryOperation,
  type TrendQuery,
} from "@/lib/edge/analytics/contract";

type TestReader = ((input: never) => Promise<unknown>) | OverviewReader;

/**
 * Adapts the old test doubles at the composition boundary. Production code
 * must construct a concrete registry; tests use this helper to keep their
 * reader assertions while exercising the same handler contract.
 */
export function createTestProviderRegistry(
  reader: TestReader,
): AnalyticsQueryRuntime {
  const registry = new AnalyticsProviderRegistry();
  for (const operation of analyticsOperationRegistry) {
    registry.register(canonicalQueryOperationFor(operation.id), {
      execute: async (
        query: CanonicalQuery<QueryOperation>,
        execution?: { readonly signal?: AbortSignal },
      ) => {
        const input = {
          ...(query as unknown as Record<string, unknown>),
          signal: execution?.signal,
        };
        if (typeof reader === "function") {
          const legacyResult = await reader(input as never);
          if (
            legacyResult &&
            typeof legacyResult === "object" &&
            "data" in legacyResult &&
            "source" in legacyResult &&
            "approximateVisitors" in legacyResult
          ) {
            const { data, source, approximateVisitors } = legacyResult as {
              readonly data: unknown;
              readonly source: "raw" | "rollup" | "realtime" | "mixed" | "mock";
              readonly approximateVisitors: boolean;
            };
            const value =
              operation.id === "team.analytics.overview" &&
              data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              !("current" in data)
                ? { current: data }
                : data;
            return { value, source, approximateVisitors };
          }
          return { value: legacyResult };
        }
        const result = operation.id.endsWith("timeseries")
          ? await executeTrend(reader, input as unknown as TrendQuery)
          : await executeOverview(reader, input as unknown as OverviewQuery);
        if (!result.ok) throw new Error(result.error.kind);
        return {
          value: result.data,
          source: result.meta.source,
          approximateVisitors: result.meta.approximateVisitors,
        };
      },
    } as never);
  }
  return createAnalyticsQueryRuntime(registry);
}
