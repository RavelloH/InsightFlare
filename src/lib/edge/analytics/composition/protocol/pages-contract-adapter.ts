import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  type PagesQuery,
  type PagesResult,
  type ReferrersQuery,
  type ReferrersResult,
  type ReferrerSummaryResult,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  mapPages,
  mapReferrers,
  mapTabs,
  parseBooleanFlag,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  PagesWithTabsResult,
  queryPagesDashboard,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
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
  const cursor = url.searchParams.get("cursor");
  const time = toQueryTime(window);
  const includeDetails = parseBooleanFlag(url, "details");
  const query = {
    context: queryContext,
    time,
    filters,
    limit,
    includeDetails,
    includeTabs,
    page: { limit, ...(cursor ? { cursor } : {}) },
  } as PagesQuery & { readonly includeTabs: boolean };
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<PagesResult | PagesWithTabsResult>("pages", query);
  if (!result.ok) return queryErrorResponse(result.error);
  const pagesResult = includeTabs
    ? (result.data as PagesWithTabsResult).pages
    : (result.data as PagesResult);
  const payload: Record<string, unknown> = {
    ok: true,
    data: {
      items: mapPages([...pagesResult.items]),
      pagination: pagesResult.pagination,
    },
  };
  if (includeTabs) {
    const tabs = (result.data as PagesWithTabsResult).tabs;
    payload.tabs = {
      path: mapTabs(tabs.path),
      title: mapTabs(tabs.title),
      hostname: mapTabs(tabs.hostname),
      entry: mapTabs(tabs.entry),
      exit: mapTabs(tabs.exit),
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
  const cursor = url.searchParams.get("cursor");
  const search = parseListSearch(url) ?? undefined;
  const sort =
    url.searchParams.get("sort") === "visitors" ? "visitors" : "views";
  const direction =
    url.searchParams.get("direction") === "asc" ? "asc" : "desc";
  const includeFullUrl = allowFullUrlParam && parseBooleanFlag(url, "fullUrl");
  const query = {
    context: queryContext,
    time,
    filters,
    limit,
    includeFullUrl,
    search,
    sort,
    direction,
    page: { limit, ...(cursor ? { cursor } : {}) },
  } satisfies ReferrersQuery;
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<ReferrersResult>("referrers", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    data: {
      items: mapReferrers([...result.data.items]),
      pagination: result.data.pagination,
    },
  });
}

export async function handleReferrerSummaryContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const topN = parseQueryLimit(url, "topN", 5, 1, 20);
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<ReferrerSummaryResult>("referrers", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    limit: topN,
    includeFullUrl: false,
    variant: "summary",
    topN,
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
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
  const limit = parseQueryLimit(url, "limit", 12, 1, 24);
  const cursor = url.searchParams.get("cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Awaited<ReturnType<typeof queryPagesDashboard>>
  >("pages-dashboard", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    interval: parseInterval(url),
    page: { limit, cursor },
    audience: queryContext.policy.audience,
  } as BaseQuery & {
    readonly interval: ReturnType<typeof parseInterval>;
    readonly page: { readonly limit: number; readonly cursor: string | null };
    readonly audience: "private-dashboard" | "public-share" | "api-v1";
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    data: {
      items: result.data.items,
      pagination: result.data.pagination,
    },
    interval: result.data.interval,
  });
}
