import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { TypedQueryOperationInvocation } from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  CanonicalQuery,
  CanonicalResult,
  QueryOperation,
} from "@/lib/edge/analytics/contract";

import { createAnalyticsQueryApplicationService } from "./query-application-service";

export interface AnalyticsQueryExecutor {
  execute<Operation extends QueryOperation>(
    operation: Operation,
    query: CanonicalQuery<Operation>,
    execution?: QueryExecutionContext,
  ): Promise<AnalyticsResult<CanonicalResult<Operation>>>;
}
export type AnalyticsQueryRuntime = AnalyticsQueryExecutor;

/**
 * Runtime boundary shared by HTTP, SSR, and test adapters.
 *
 * Concrete providers are assembled before this object is created. The
 * runtime deliberately exposes no source or reader selection API.
 */
export function createAnalyticsQueryRuntime(
  providerRegistry: AnalyticsProviderRegistry,
  service = createAnalyticsQueryApplicationService(),
): AnalyticsQueryExecutor {
  const executor = {
    execute<Operation extends QueryOperation>(
      operation: Operation,
      query: CanonicalQuery<Operation>,
      execution: QueryExecutionContext = {},
    ): Promise<AnalyticsResult<CanonicalResult<Operation>>> {
      const invocation: TypedQueryOperationInvocation<Operation> = {
        kind: "typed-query",
        operation,
        query,
        providerRegistry,
        ...(execution.cache
          ? {
              cache: {
                ...execution.cache,
                isCacheable: execution.cache.isCacheable as
                  ((value: CanonicalResult<Operation>) => boolean) | undefined,
              },
            }
          : {}),
      };
      const requestService = execution.cacheStore
        ? createAnalyticsQueryApplicationService(execution.cacheStore)
        : service;
      return requestService.execute(invocation, execution);
    },
  };
  return executor as AnalyticsQueryExecutor;
}
