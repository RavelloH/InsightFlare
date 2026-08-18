import type { FilterValuesResult } from "@/lib/edge/query-contract";
import {
  analyticsFilterDefinition,
  executeQueryOperation,
  parseFilterUrlForAudience,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  parseFilterOptionKey,
  parseLimit,
  parseListSearch,
  parseWindow,
  type ResponseContext,
  withoutFilterKey,
} from "./core";
import { queryFilterValuesFromD1 } from "./filter-values";
import { toQueryTime } from "./overview-contract-adapter";

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
  const result = await executeQueryOperation<FilterValuesResult>(
    "filter-values",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters,
    },
    async () => ({
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
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
