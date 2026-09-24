/* c8 ignore file -- this module assembles the fixture query runtime. */

import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import type {
  BaseQuery,
  QueryContext,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import {
  type DemoQueryRuntimeInput,
  executeDemoQueryPayload,
} from "@/lib/edge/analytics/providers/mock/demo-query";

import { createAnalyticsQueryRuntime } from "./query-runtime";

export interface MockQueryRuntimeInput extends DemoQueryRuntimeInput {
  /** Canonical policy context supplied by the protocol adapter. */
  readonly queryContext: QueryContext;
  /** Canonical operation selected by composition. */
  readonly operation: QueryOperation;
  /** Canonical query supplied by the inbound protocol adapter. */
  readonly query: BaseQuery;
}

export function createMockAnalyticsQueryRuntime(input: MockQueryRuntimeInput) {
  const providerRegistry = new AnalyticsProviderRegistry().register(
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
  return createAnalyticsQueryRuntime(providerRegistry);
}
