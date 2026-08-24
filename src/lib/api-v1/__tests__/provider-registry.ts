import { analyticsOperationRegistry } from "@/lib/edge/analytics/application/operation-registry";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import {
  executeOverview,
  executeTrend,
  type OverviewQuery,
  type OverviewReader,
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
): AnalyticsProviderRegistry {
  const registry = new AnalyticsProviderRegistry();
  for (const operation of analyticsOperationRegistry) {
    registry.register(canonicalQueryOperationFor(operation.id), {
      execute: async (query, execution) => {
        const input = {
          ...(query as unknown as Record<string, unknown>),
          signal: execution?.signal,
        };
        const value =
          typeof reader === "function"
            ? await reader(input as never)
            : operation.id.endsWith("timeseries")
              ? await executeTrend(reader, input as unknown as TrendQuery)
              : await executeOverview(
                  reader,
                  input as unknown as OverviewQuery,
                );
        return { value };
      },
    });
  }
  return registry;
}
