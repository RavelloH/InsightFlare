import type { FilterValuesResult } from "@/lib/edge/analytics/contract";
import {
  analyticsFilterDefinition,
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
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
import { queryFilterValuesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
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
  const result = await executeTypedApplicationOperation<FilterValuesResult>(
    "filter-values",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters,
    },
    createTypedQueryProviderRegistry("filter-values", async () => ({
      value: {
        field,
        data: (
          await queryFilterValuesFromD1(
            env,
            siteId,
            window,
            filters,
            field,
            parseLimit(url, 50, 500),
            parseListSearch(url),
          )
        ).map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      },
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
