import { type AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { validateTypedQueryFilters } from "@/lib/edge/analytics/application/query-validation";
import {
  TypedQueryApplicationService,
  type TypedQueryOperationInvocation,
} from "@/lib/edge/analytics/application/service";

import type { AnalyticsResult, BaseQuery, QueryOperation } from "./types";

export type {
  TypedQueryProvider,
  TypedQueryProviderResult,
} from "@/lib/edge/analytics/application/provider-registry";
export {
  AnalyticsProviderRegistry,
  createTypedQueryProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";

export { validateTypedQueryFilters };

/**
 * Contract/application bridge. It delegates execution to the canonical
 * application service and accepts only a canonical provider registry.
 */
export async function executeTypedApplicationOperation<T>(
  operation: QueryOperation,
  input: BaseQuery,
  providerRegistry: AnalyticsProviderRegistry,
): Promise<AnalyticsResult<T>> {
  const invocation: TypedQueryOperationInvocation<T> = {
    kind: "typed-query",
    operation,
    query: input,
    providerRegistry,
  };
  return new TypedQueryApplicationService().execute(invocation);
}
