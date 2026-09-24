import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  parseFilterUrlForAudience,
  withoutGeoFilter,
} from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
  parseBooleanSearchParam,
  parseLimit,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
export async function handleOverviewGeoPointsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseBooleanSearchParam(url, "applyGeoFilter")
    ? parseFilterUrlForAudience(queryContext.policy.audience, url)
    : withoutGeoFilter(
        parseFilterUrlForAudience(queryContext.policy.audience, url),
      );
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "geo-points",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      limit: parseLimit(url, 5000, 20000),
    } as BaseQuery & { readonly limit: number },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  const { points, ...summary } = result.data;
  return jsonResponseWith(ctx!, { ok: true, ...summary, data: points });
}
