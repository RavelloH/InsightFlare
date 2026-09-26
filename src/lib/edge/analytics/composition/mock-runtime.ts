/* c8 ignore file -- this module assembles the fixture query runtime. */

import {
  AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import type {
  BaseQuery,
  CanonicalResult,
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
    typedQueryProviderFor(input.operation, async (query) => {
      const resolvedScope =
        "scopePlan" in query ? query.scopePlan?.scope : undefined;
      const demoInput = resolvedScope
        ? { ...input, query, canonicalQuery: query, resolvedScope }
        : { ...input, query, canonicalQuery: query };
      return {
        value: (await executeDemoQueryPayload(
          demoInput,
        )) as unknown as CanonicalResult<typeof input.operation>,
        source: "mock" as const,
      };
    }),
  );
  return createAnalyticsQueryRuntime(providerRegistry);
}
