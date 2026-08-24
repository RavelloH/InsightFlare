import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import {
  type AnalyticsOperationProvider,
  analyticsOperationProvider,
  TypedApplicationProviderRegistry,
} from "@/lib/edge/analytics/application/provider-registry";

export function createProviderRegistry(): TypedApplicationProviderRegistry {
  return new TypedApplicationProviderRegistry();
}

export function createRegisteredProviderRegistry<Query, Result>(
  operation: AnalyticsOperationId,
  provider: AnalyticsOperationProvider<Query, Result>,
): TypedApplicationProviderRegistry {
  return createProviderRegistry().register(operation, provider);
}

export function createCallbackProviderRegistry<Query, Result>(
  operation: AnalyticsOperationId,
  execute: (
    query: Query,
    execution: Parameters<
      AnalyticsOperationProvider<Query, Result>["execute"]
    >[0]["execution"],
  ) => Promise<Result>,
): TypedApplicationProviderRegistry {
  return createRegisteredProviderRegistry(
    operation,
    analyticsOperationProvider(execute),
  );
}
