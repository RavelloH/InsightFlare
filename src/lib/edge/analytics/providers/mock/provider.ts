/* c8 ignore file -- this module bridges fixture transport and typed queries. */

import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type BaseQuery,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  parseFilterParams,
  parseFilterScopePreference,
  type QueryContext,
  type QueryOperation,
} from "@/lib/edge/analytics/contract";
import { parseWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { appNow } from "@/lib/edge/e2e-clock";

import {
  type DemoQueryRuntimeInput,
  executeDemoQueryPayload,
} from "./demo-query";

export interface MockQueryProviderInput extends DemoQueryRuntimeInput {
  /** Canonical policy context supplied by the Private/Public adapter. */
  readonly queryContext: QueryContext;
  /** The operation selected by the protocol adapter. */
  readonly operation: QueryOperation;
}

function mockQuery(input: MockQueryProviderInput): BaseQuery {
  const parsedWindow = parseWindow(input.url);
  const nowMs = parsedWindow?.nowMs ?? appNow();
  const startMs = parsedWindow?.startMs ?? Math.max(0, nowMs - 86_400_000);
  const endExclusiveMs = Math.max(
    startMs + 1,
    parsedWindow?.endExclusiveMs ?? nowMs,
  );
  let filters = EMPTY_FILTER_DOCUMENT;
  try {
    filters = attachFilterScopePreference(
      parseFilterParams(input.url, analyticsFilterRegistry),
      parseFilterScopePreference(input.url),
    );
  } catch {
    // The protocol layer owns filter validation. Keep the mock transport
    // deterministic if it is called directly with an invalid query string.
  }
  return {
    context: input.queryContext,
    time: createQueryTime(
      startMs,
      endExclusiveMs,
      parsedWindow?.timeZone,
      nowMs,
    ),
    filters,
    scopePreference: parseFilterScopePreference(input.url),
  };
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

export function createMockQuery(input: MockQueryProviderInput): BaseQuery {
  return mockQuery(input);
}
