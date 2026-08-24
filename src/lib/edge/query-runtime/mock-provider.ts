/* c8 ignore file -- this module bridges fixture transport and typed queries. */

import { appNow } from "@/lib/edge/e2e-clock";
import {
  getRequestId,
  parseWindow,
  queryErrorResponse,
} from "@/lib/edge/query/core";
import {
  type BaseQuery,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  executeTypedApplicationOperation,
  type QueryContext,
  type QueryOperation,
} from "@/lib/edge/query-contract";

import {
  createDemoQueryResponse,
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

/**
 * Mock provider entry point. The fixture generator remains the data-source
 * implementation, while application policy and result metadata are applied
 * through the same typed boundary as D1-backed queries.
 */
export async function executeMockQuery(
  input: MockQueryProviderInput,
): Promise<Response> {
  const result = await executeTypedApplicationOperation(
    input.operation,
    mockQuery(input),
    async () => ({
      value: await executeDemoQueryPayload(input),
      source: "mock" as const,
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);

  return createDemoQueryResponse(
    result.data.payload,
    result.data.status,
    Boolean(input.publicQuery),
    input.context ?? {
      requestId: getRequestId(input.request),
    },
  );
}
