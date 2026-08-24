import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  type PagesQuery,
  type PagesResult,
  type ReferrersQuery,
  type ReferrersResult,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  mapPages,
  mapReferrers,
  mapTabs,
  paginationOffset,
  parseBooleanFlag,
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { queryPageTabsAggregate } from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export async function handlePagesContract(
  env: Env,
  siteId: string,
  url: URL,
  includeTabs: boolean,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(
    siteId,
    includeTabs ? "private-dashboard" : "public-share",
  ),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const limit = parseLimit(url, 20, 200);
  const time = toQueryTime(window);
  const includeDetails = parseBooleanFlag(url, "details");
  const query = {
    context: queryContext,
    time,
    filters,
    limit,
    includeDetails,
  } satisfies PagesQuery;
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<PagesResult>("pages", query);
  if (!result.ok) return queryErrorResponse(result.error);
  const payload: Record<string, unknown> = {
    ok: true,
    data: mapPages([...result.data.items]),
  };
  if (includeTabs) {
    const tabsResult = await createD1SiteQueryRuntime({
      env,
      siteId,
    }).execute<Awaited<ReturnType<typeof queryPageTabsAggregate>>>("pages", {
      context: queryContext,
      time: toQueryTime(window),
      filters,
      variant: "tabs",
      limit,
    } as BaseQuery & { readonly variant: "tabs"; readonly limit: number });
    if (!tabsResult.ok) return queryErrorResponse(tabsResult.error);
    payload.tabs = {
      path: mapTabs(tabsResult.data.path),
      title: mapTabs(tabsResult.data.title),
      hostname: mapTabs(tabsResult.data.hostname),
      entry: mapTabs(tabsResult.data.entry),
      exit: mapTabs(tabsResult.data.exit),
    };
  }
  return jsonResponseWith(ctx!, payload);
}

export async function handleReferrersContract(
  env: Env,
  siteId: string,
  url: URL,
  fallbackLimit = 20,
  allowFullUrlParam = true,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(
    siteId,
    allowFullUrlParam ? "private-dashboard" : "public-share",
  ),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const time = toQueryTime(window);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const limit = parseLimit(url, fallbackLimit, 200);
  const includeFullUrl = allowFullUrlParam && parseBooleanFlag(url, "fullUrl");
  const query = {
    context: queryContext,
    time,
    filters,
    limit,
    includeFullUrl,
  } satisfies ReferrersQuery;
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<ReferrersResult>("referrers", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    data: mapReferrers([...result.data.items]),
  });
}

export async function handlePagesDashboardContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const page = parseQueryLimit(url, "page", 1, 1, 10_000);
  const pageSize = parseQueryLimit(url, "pageSize", 12, 1, 24);
  const offset = paginationOffset(page, pageSize);
  if (offset === null) {
    return badRequest(
      "Pagination depth exceeds 20,000 rows; narrow the time range or filters",
    );
  }
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Awaited<ReturnType<typeof queryPagesDashboard>>
  >("pages-dashboard", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    interval: parseInterval(url),
    page,
    pageSize,
    offset,
  } as BaseQuery & {
    readonly interval: ReturnType<typeof parseInterval>;
    readonly page: number;
    readonly pageSize: number;
    readonly offset: number;
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
