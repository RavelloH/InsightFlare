import type {
  AnalyticsResult,
  CanonicalQuery,
  CanonicalResult,
  QueryOperation,
} from "@/lib/edge/analytics/contract";

import {
  AnalyticsProviderRegistry,
  createTypedQueryProviderRegistry,
  typedQueryProviderFor,
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
  typedQueryProviderFor,
};
/** Executes a canonical query through the application service and provider registry. */
export async function executeTypedApplicationOperation<
  Operation extends QueryOperation,
>(
  operation: Operation,
  input: CanonicalQuery<Operation>,
  providerRegistry: AnalyticsProviderRegistry,
): Promise<AnalyticsResult<CanonicalResult<Operation>>> {
  const invocation: TypedQueryOperationInvocation<Operation> = {
    kind: "typed-query",
    operation,
    query: input,
    providerRegistry,
  };
  return new TypedQueryApplicationService().execute(invocation);
}
