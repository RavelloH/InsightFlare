import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import type { TypedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import type { QueryOperation } from "@/lib/edge/analytics/contract";

export function createProviderRegistry(): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry();
}

/**
 * Creates the API adapter registry for a reader while keeping callback
 * adaptation inside the canonical registry implementation.
 */
export function createReaderProviderRegistry<
  Reader extends (...args: never[]) => Promise<unknown>,
>(
  operation: AnalyticsOperationId | QueryOperation,
  reader: Reader,
): AnalyticsProviderRegistry {
  type Input = Parameters<Reader>[0];
  type Result = Awaited<ReturnType<Reader>>;
  const canonicalOperation = (
    operation.includes(".")
      ? canonicalQueryOperationFor(operation as AnalyticsOperationId)
      : operation
  ) as QueryOperation;
  const provider: TypedQueryProvider<Result> = {
    execute: async (input, execution) => ({
      value: (await reader({
        ...(input as object),
        signal: execution?.signal,
      } as Input)) as Result,
    }),
  };
  return createProviderRegistry().register(canonicalOperation, provider);
}
