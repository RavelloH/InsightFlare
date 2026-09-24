/* c8 ignore file -- this module bridges fixture transport and typed queries. */

import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import {
  type BaseQuery,
  type QueryContext,
  type QueryOperation,
} from "@/lib/edge/analytics/contract";

import {
  type DemoQueryRuntimeInput,
  executeDemoQueryPayload,
} from "./demo-query";
export interface MockQueryProviderInput extends DemoQueryRuntimeInput {
  /** Canonical policy context supplied by the Private/Public adapter. */
  readonly queryContext: QueryContext;
  /** The operation selected by the protocol adapter. */
  readonly operation: QueryOperation;
  /** Canonical query supplied by the inbound protocol adapter. */
  readonly query: BaseQuery;
}
export function createMockProviderRegistry(input: MockQueryProviderInput) {
  return new AnalyticsProviderRegistry().register(
    input.operation,
    typedQueryProvider(async (query) => {
      const resolvedScope = query?.scopePlan?.scope;
      const demoInput = resolvedScope ? { ...input, resolvedScope } : input;
      return {
        value: await executeDemoQueryPayload(demoInput),
        source: "mock" as const,
      };
    }),
  );
}
