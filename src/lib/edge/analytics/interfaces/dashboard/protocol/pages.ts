import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type PagesDashboardComparisonQuery,
  type PagesDashboardQuery,
  type PagesQuery,
  previousComparableWindow,
  type ReferrersQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
  parseBooleanFlag,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import {
  mapPages,
  mapReferrers,
  mapTabs,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/serializers";
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
  const time = queryWindowToTime(window);
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
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("pages", query);
  if (!result.ok) return queryErrorResponse(result.error);
  const pagesResult =
    "pages" in result.data
      ? result.data.pages
      : "items" in result.data && "pagination" in result.data
        ? result.data
        : null;
  if (!pagesResult) throw new Error("pages_result_shape_mismatch");
  const payload: Record<string, unknown> = {
    ok: true,
    data: {
      items: mapPages([...pagesResult.items]),
      pagination: pagesResult.pagination,
    },
  };
  if (includeTabs) {
    if (!("tabs" in result.data)) {
      throw new Error("pages_tabs_result_shape_mismatch");
    }
    const tabs = result.data.tabs;
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
  const time = queryWindowToTime(window);
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
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("referrers", query);
  if (!result.ok) return queryErrorResponse(result.error);
  if (!("items" in result.data)) {
    throw new Error("referrers_result_shape_mismatch");
  }
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
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("referrers", {
    context: queryContext,
    time: queryWindowToTime(window),
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
  const limit = parseQueryLimit(url, "limit", 12, 1, 25);
  const cursor = url.searchParams.get("cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const search = parseListSearch(url);
  const rawSort = url.searchParams.get("sort");
  const pageMetrics = [
    "views",
    "visitors",
    "sessions",
    "bounceRate",
    "pagesPerSession",
    "avgDurationMs",
  ] as const;
  if (
    rawSort !== null &&
    !pageMetrics.includes(rawSort as (typeof pageMetrics)[number])
  ) {
    return badRequest("Invalid sort", "invalid-input");
  }
  const rawDirection = url.searchParams.get("direction");
  if (
    rawDirection !== null &&
    rawDirection !== "asc" &&
    rawDirection !== "desc"
  ) {
    return badRequest("Invalid direction", "invalid-input");
  }
  const sort = (rawSort ?? "views") as (typeof pageMetrics)[number];
  const direction = rawDirection ?? "desc";
  const compare = url.searchParams.get("compare");
  if (compare !== null && compare !== "same" && compare !== "previous") {
    return badRequest("Invalid comparison", "invalid-input");
  }
  const compareFilterParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.startsWith("compareFilter[")) {
      compareFilterParams.append(
        `filter${key.slice("compareFilter".length)}`,
        value,
      );
    }
  }
  const comparisonMetric = pageMetrics.includes(
    url.searchParams.get("metric") as (typeof pageMetrics)[number],
  )
    ? (url.searchParams.get("metric") as (typeof pageMetrics)[number])
    : "views";
  const comparisonSortBy =
    url.searchParams.get("sortBy") === "reference"
      ? "reference"
      : url.searchParams.get("sortBy") === "change"
        ? "change"
        : "current";
  let comparison: PagesDashboardComparisonQuery | undefined;
  if (compare === "same" || compare === "previous") {
    const referenceFilters = compareFilterParams.size
      ? parseFilterUrlForAudience(
          queryContext.policy.audience,
          compareFilterParams,
        )
      : compare === "previous"
        ? filters
        : ({ version: 1, root: null } as typeof filters);
    if (compare !== "same" || referenceFilters.root) {
      const referenceWindow =
        compare === "previous" ? previousComparableWindow(window) : window;
      comparison = {
        current: { time: queryWindowToTime(window), filters },
        reference: {
          time: queryWindowToTime(referenceWindow),
          filters: referenceFilters,
        },
        metric: comparisonMetric,
        sortBy: comparisonSortBy,
        direction,
      };
    }
  }
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("pages-dashboard", {
    context: queryContext,
    time: queryWindowToTime(window),
    filters,
    interval: parseInterval(url),
    search,
    sort: { key: sort, direction },
    ...(comparison ? { comparison } : {}),
    page: { limit, cursor },
    audience: queryContext.policy.audience,
  } satisfies PagesDashboardQuery);
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
