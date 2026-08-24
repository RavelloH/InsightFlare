/* c8 ignore file -- this module bridges mock transport and typed queries. */

import {
  getRequestId,
  queryErrorResponse,
} from "@/lib/edge/analytics/composition/mock-provider";
import {
  createDemoQueryResponse,
  type DemoQueryPayloadResult,
} from "@/lib/edge/analytics/composition/mock-provider";
import {
  createMockProviderRegistry,
  createMockQuery,
  type MockQueryProviderInput,
} from "@/lib/edge/analytics/composition/mock-provider";
import { executeTypedApplicationOperation } from "@/lib/edge/analytics/contract";

export type { MockQueryProviderInput } from "@/lib/edge/analytics/composition/mock-provider";

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
