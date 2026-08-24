import { analyticsOperationRegistry } from "@/lib/edge/analytics/application/operation-registry";
import {
  analyticsOperationProvider,
  TypedApplicationProviderRegistry,
} from "@/lib/edge/analytics/application/provider-registry";
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
): TypedApplicationProviderRegistry {
  const registry = new TypedApplicationProviderRegistry();
  for (const operation of analyticsOperationRegistry) {
    registry.register(
      operation.id,
      analyticsOperationProvider(async (query: unknown, execution) => {
        const input = {
          ...(query as Record<string, unknown>),
          signal: execution.signal,
        };
        if (typeof reader === "function") return reader(input as never);
        return operation.id.endsWith("timeseries")
          ? executeTrend(reader, input as unknown as TrendQuery)
          : executeOverview(reader, input as unknown as OverviewQuery);
      }),
    );
  }
  return registry;
}
