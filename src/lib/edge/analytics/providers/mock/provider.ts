/* c8 ignore file -- this module bridges fixture transport and typed queries. */

import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import {
  type BaseQuery,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
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
  return {
    context: input.queryContext,
    time: createQueryTime(
      startMs,
      endExclusiveMs,
      parsedWindow?.timeZone,
      nowMs,
    ),
    filters: EMPTY_FILTER_DOCUMENT,
  };
}

export function createMockProviderRegistry(input: MockQueryProviderInput) {
  return new AnalyticsProviderRegistry().register(
    input.operation,
    typedQueryProvider(async () => ({
      value: await executeDemoQueryPayload(input),
      source: "mock" as const,
    })),
  );
}

export function createMockQuery(input: MockQueryProviderInput): BaseQuery {
  return mockQuery(input);
}
