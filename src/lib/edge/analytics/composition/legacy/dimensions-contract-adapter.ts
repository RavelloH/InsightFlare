import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1-site-query-runtime";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type DimensionQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { mapDimensionRows } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  badRequest,
  jsonResponseWith,
  parseLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
  withoutGeoFilter,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export type SimpleDimensionKey =
  | "country"
  | "page.query"
  | "page.hash"
  | "utm.source"
  | "utm.medium"
  | "utm.campaign"
  | "utm.term"
  | "utm.content";

export async function handleSimpleDimensionContract(
  env: Env,
  siteId: string,
  url: URL,
  dimension: SimpleDimensionKey,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawFilters = parseFilterUrlForAudience(
    queryContext.policy.audience,
    url,
  );
  const filters =
    dimension === "country" ? withoutGeoFilter(rawFilters) : rawFilters;
  const query = {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    dimension,
    limit: parseLimit(url, 20, 200),
  } satisfies DimensionQuery;
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    ReturnType<typeof mapDimensionRows>
  >("dimension", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
