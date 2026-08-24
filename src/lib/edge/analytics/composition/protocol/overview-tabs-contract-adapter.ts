import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
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

export type OverviewTab =
  | "page.path"
  | "page.title"
  | "page.hostname"
  | "page.entry"
  | "page.exit"
  | "source.domain"
  | "source.link"
  | "source.channel"
  | "client.browser"
  | "client.osVersion"
  | "client.deviceType"
  | "client.language"
  | "client.screenSize"
  | "geo.country"
  | "geo.region"
  | "geo.city"
  | "geo.continent"
  | "geo.timezone"
  | "geo.organization";

export async function handleOverviewTabContract(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewTab,
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
    tab === "geo.country" ? withoutGeoFilter(rawFilters) : rawFilters;
  const operation = tab === "source.channel" ? "channels" : "dimension";
  const query = {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    tab,
    limit: parseLimit(url, 100, 200),
  } as BaseQuery & { readonly tab: OverviewTab; readonly limit: number };
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly data: readonly unknown[];
  }>(operation, query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
