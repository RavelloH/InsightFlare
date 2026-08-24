import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import {
  TypedQueryApplicationService,
  type TypedQueryOperationInvocation,
} from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
} from "@/lib/edge/analytics/contract";

type CanonicalRuntimeQuery =
  | BaseQuery
  | (BaseQuery & Readonly<Record<string, unknown>>);

export interface AnalyticsQueryRuntime {
  readonly providerRegistry: AnalyticsProviderRegistry;
  execute<Result>(
    operation: QueryOperation,
    query: CanonicalRuntimeQuery,
    execution?: QueryExecutionContext,
  ): Promise<AnalyticsResult<Result>>;
}

/**
 * Runtime boundary shared by HTTP, SSR, and test adapters.
 *
 * Concrete providers are assembled before this object is created. The
 * runtime deliberately exposes no source or reader selection API.
 */
export function createAnalyticsQueryRuntime(
  providerRegistry: AnalyticsProviderRegistry,
  service = new TypedQueryApplicationService(),
): AnalyticsQueryRuntime {
  return {
    providerRegistry,
    execute<Result>(
      operation: QueryOperation,
      query: CanonicalRuntimeQuery,
      execution: QueryExecutionContext = {},
    ): Promise<AnalyticsResult<Result>> {
      const invocation: TypedQueryOperationInvocation<Result> = {
        kind: "typed-query",
        operation,
        query,
        providerRegistry,
      };
      return service.execute(invocation, execution);
    },
  };
}
