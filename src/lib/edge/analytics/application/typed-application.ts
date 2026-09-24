import type {
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
} from "@/lib/edge/analytics/contract/types";

import {
  AnalyticsProviderRegistry,
  createTypedQueryProviderRegistry,
  typedQueryProvider,
} from "./provider-registry";
import {
  TypedQueryApplicationService,
  type TypedQueryOperationInvocation,
} from "./service";
export type {
  TypedQueryProvider,
  TypedQueryProviderResult,
} from "./provider-registry";
export {
  AnalyticsProviderRegistry,
  createTypedQueryProviderRegistry,
  typedQueryProvider,
};
/** Executes a canonical query through the application service and provider registry. */
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
