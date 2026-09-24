import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  analyticsFilterDefinition,
  type FilterValuesQuery,
  parseFilterUrlForAudience,
  siteQueryContext,
  withoutFilterKey,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
  parseFilterOptionKey,
  parseLimit,
  parseListSearch,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
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
    time: queryWindowToTime(window),
    filters,
    field,
    limit: parseLimit(url, 50, 500),
    page: {
      limit: parseLimit(url, 50, 500),
      ...(url.searchParams.get("cursor")
        ? { cursor: url.searchParams.get("cursor") }
        : {}),
    },
    search: parseListSearch(url),
  } satisfies FilterValuesQuery;
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("filter-values", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
