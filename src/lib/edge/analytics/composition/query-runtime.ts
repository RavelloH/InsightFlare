import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { TypedQueryOperationInvocation } from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  CanonicalQuery,
  CanonicalResult,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import { safeFilterShape } from "@/lib/edge/analytics-engine/filter-shape";
import { currentHotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import {
  registeredProviderQuery,
  runWithQueryIdentity,
  setCurrentQueryFilterShape,
  setCurrentQueryVariant,
} from "@/lib/edge/analytics-engine/query-registry";
import { currentInvocationLogger } from "@/lib/edge/observability/logger";

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
      const collector = currentHotspotCollector(currentInvocationLogger());
      if (!collector) return requestService.execute(invocation, execution);
      // Query identity comes from a static typed operation, never request data.
      // All business validation and scope planning remain inside the service.
      return runWithQueryIdentity(
        { id: registeredProviderQuery(operation), variant: "unknown" },
        () =>
          requestService.execute(invocation, {
            ...execution,
            onPreparedQuery: (prepared) => {
              try {
                const shape = safeFilterShape(
                  prepared.filters ?? { version: 1, root: null },
                  prepared.scopePlan,
                );
                setCurrentQueryFilterShape(shape);
                setCurrentQueryVariant(shape.execution);
                collector.setFilter(shape);
              } catch {
                // Profiling is isolated from business query execution.
              }
              execution.onPreparedQuery?.(prepared);
            },
          }),
      );
    },
  };
  return executor as AnalyticsQueryExecutor;
}
