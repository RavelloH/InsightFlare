/* c8 ignore file -- this module bridges mock transport and typed queries. */

import {
  createDemoQueryResponse,
  createMockAnalyticsQueryRuntime,
  type DemoQueryPayloadResult,
  type MockQueryRuntimeInput,
} from "@/lib/edge/analytics/composition/mock-provider";
import {
  filterScopePreferenceFromDocument,
  parseFilterUrlForAudience,
  queryWindowToTime,
} from "@/lib/edge/analytics/contract";
import { parseWindow } from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import { queryErrorResponse } from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import { badRequest } from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import { getRequestId } from "@/lib/response";
export type MockQueryInput = Omit<MockQueryRuntimeInput, "query">;
export async function executeMockQuery(
  input: MockQueryInput,
): Promise<Response> {
  const window = parseWindow(input.url);
  if (!window) return badRequest("Invalid time window");
  let filters;
  try {
    filters = parseFilterUrlForAudience(
      input.queryContext.policy.audience,
      input.url,
    );
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : "Invalid filters",
    );
  }
  const query = {
    context: input.queryContext,
    time: queryWindowToTime(window),
    filters,
    scopePreference: filterScopePreferenceFromDocument(filters),
  };
  const result = await createMockAnalyticsQueryRuntime({
    ...input,
    query,
  }).execute(input.operation, query);
  if (!result.ok) return queryErrorResponse(result.error);
  const payload = result.data as unknown as DemoQueryPayloadResult;

  return createDemoQueryResponse(
    payload.payload,
    payload.status,
    Boolean(input.publicQuery),
    input.context ?? {
      requestId: getRequestId(input.request),
    },
  );
}
