/* c8 ignore file -- this module bridges mock transport and typed queries. */

import { executeTypedApplicationOperation } from "@/lib/edge/analytics/contract";
import {
  getRequestId,
  queryErrorResponse,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createDemoQueryResponse,
  type DemoQueryPayloadResult,
} from "@/lib/edge/analytics/providers/mock/demo-query";
import {
  createMockProviderRegistry,
  createMockQuery,
  type MockQueryProviderInput,
} from "@/lib/edge/analytics/providers/mock/provider";

export type { MockQueryProviderInput } from "@/lib/edge/analytics/providers/mock/provider";

export async function executeMockQuery(
  input: MockQueryProviderInput,
): Promise<Response> {
  const result = await executeTypedApplicationOperation<DemoQueryPayloadResult>(
    input.operation,
    createMockQuery(input),
    createMockProviderRegistry(input),
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
