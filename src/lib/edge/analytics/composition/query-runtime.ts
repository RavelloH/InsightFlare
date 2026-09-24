import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { TypedQueryOperationInvocation } from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
} from "@/lib/edge/analytics/contract";

import { createAnalyticsQueryApplicationService } from "./query-application-service";

type CanonicalRuntimeQuery =
  BaseQuery | (BaseQuery & Readonly<Record<string, unknown>>);

export interface AnalyticsQueryExecutor {
  execute<Result>(
    operation: QueryOperation,
    query: CanonicalRuntimeQuery,
    execution?: QueryExecutionContext,
  ): Promise<AnalyticsResult<Result>>;
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
  return {
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
        ...(execution.cache
          ? {
              cache: {
                ...execution.cache,
                isCacheable: execution.cache.isCacheable as
                  ((value: Result) => boolean) | undefined,
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
}
