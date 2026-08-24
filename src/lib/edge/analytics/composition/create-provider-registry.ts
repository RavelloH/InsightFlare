import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

export function createProviderRegistry(): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry();
}

/**
 * Creates the API adapter registry for a reader while keeping callback
 * adaptation inside the canonical registry implementation.
 */
export function createReaderProviderRegistry<
  Reader extends (...args: never[]) => Promise<unknown>,
>(operation: AnalyticsOperationId, reader: Reader): AnalyticsProviderRegistry {
  type Input = Parameters<Reader>[0];
  type Result = Awaited<ReturnType<Reader>>;
  return createProviderRegistry().registerCallback<Input, Result>(
    operation,
    (input, execution) =>
      reader({
        ...(input as object),
        signal: execution.signal,
      } as Input) as Promise<Result>,
  );
}
