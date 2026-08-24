import type { TypedQueryProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { validateTypedQueryFilters } from "@/lib/edge/analytics/application/query-validation";
import {
  TypedQueryApplicationService,
  type TypedQueryOperationInvocation,
} from "@/lib/edge/analytics/application/service";

import type { AnalyticsResult, BaseQuery, QueryOperation } from "./types";

export type {
  TypedQueryProvider,
  TypedQueryProviderResult,
  TypedQueryResultProvider,
} from "@/lib/edge/analytics/application/provider-registry";
export {
  createTypedQueryProviderRegistry,
  createTypedQueryResultProviderRegistry,
  typedQueryProvider,
  TypedQueryProviderRegistry,
  typedQueryResultProvider,
} from "@/lib/edge/analytics/application/provider-registry";

export { validateTypedQueryFilters };

/**
 * Compatibility entry point for contract adapters. The application service
 * owns execution; this function only selects the canonical provider registry
 * mode and preserves the existing AnalyticsResult envelope.
 */
export async function executeTypedApplicationOperation<T>(
  operation: QueryOperation,
  input: BaseQuery,
  providerRegistry: TypedQueryProviderRegistry,
): Promise<AnalyticsResult<T>> {
  const invocation: TypedQueryOperationInvocation<T> = {
    kind: "typed-query",
    operation,
    query: input,
    providerRegistry,
    resultMode: "value",
  };
  return new TypedQueryApplicationService().execute(invocation);
}

/**
 * Compatibility entry point for composite contract providers. It delegates
 * to the same application service and requests the already-enveloped mode.
 */
export async function executeTypedApplicationResult<T>(
  operation: QueryOperation,
  input: BaseQuery,
  providerRegistry: TypedQueryProviderRegistry,
): Promise<AnalyticsResult<T>> {
  const invocation: TypedQueryOperationInvocation<T> = {
    kind: "typed-query",
    operation,
    query: input,
    providerRegistry,
    resultMode: "result",
  };
  return new TypedQueryApplicationService().execute(invocation);
}
