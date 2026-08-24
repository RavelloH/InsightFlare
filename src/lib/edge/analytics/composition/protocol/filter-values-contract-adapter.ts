import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import type { FilterValuesResult } from "@/lib/edge/analytics/contract";
import {
  analyticsFilterDefinition,
  type FilterValuesQuery,
  parseFilterUrlForAudience,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  parseFilterOptionKey,
  parseLimit,
  parseListSearch,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
  withoutFilterKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export async function handleFilterValuesContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const field = parseFilterOptionKey(url);
  const definition = field ? analyticsFilterDefinition(field) : undefined;
  if (
    !field ||
    !definition ||
    !definition.audiences.has(queryContext.policy.audience)
  ) {
    return badRequest("Invalid filter field");
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = withoutFilterKey(
    parseFilterUrlForAudience(queryContext.policy.audience, url),
    field,
  );
  const query = {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    field,
    limit: parseLimit(url, 50, 500),
    search: parseListSearch(url),
  } satisfies FilterValuesQuery;
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<FilterValuesResult>("filter-values", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
