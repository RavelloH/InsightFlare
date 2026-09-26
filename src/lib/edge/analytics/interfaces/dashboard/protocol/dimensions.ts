import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  type CanonicalDimensionQuery,
  type FilterDocument,
  type OverviewTableComparisonQuery,
  parseFilterUrlForAudience,
  previousComparableWindow,
  withoutGeoFilter,
} from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
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
  const rawSort = url.searchParams.get("sort");
  if (
    rawSort !== null &&
    rawSort !== "views" &&
    rawSort !== "sessions" &&
    rawSort !== "visitors"
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
  const limit = parseLimit(url, 20, 200);
  const cursor = url.searchParams.get("cursor");
  const sort = rawSort ?? "views";
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
  let comparison: OverviewTableComparisonQuery | undefined;
  if (
    (dimension === "page.hash" || dimension.startsWith("utm.")) &&
    (compare === "same" || compare === "previous")
  ) {
    const referenceFilters: FilterDocument = compareFilterParams.size
      ? parseFilterUrlForAudience(
          queryContext.policy.audience,
          compareFilterParams,
        )
      : compare === "previous"
        ? filters
        : ({ version: 1, root: null } as FilterDocument);
    if (compare !== "same" || referenceFilters.root) {
      const referenceWindow =
        compare === "previous" ? previousComparableWindow(window) : window;
      const comparisonMetric = url.searchParams.get("metric");
      const comparisonSortBy = url.searchParams.get("sortBy");
      comparison = {
        current: {
          time: queryWindowToTime(window),
          filters,
        },
        reference: {
          time: queryWindowToTime(referenceWindow),
          filters: referenceFilters,
        },
        metric:
          comparisonMetric === "visitors"
            ? "visitors"
            : comparisonMetric === "sessions"
              ? "sessions"
              : "views",
        sortBy:
          comparisonSortBy === "reference"
            ? "reference"
            : comparisonSortBy === "change"
              ? "change"
              : "current",
        direction,
      };
    }
  }
  const query = {
    context: queryContext,
    time: queryWindowToTime(window),
    filters,
    ...(comparison
      ? {
          mode: "overview-tab" as const,
          tab: dimension,
          limit,
          cursor: cursor ?? "",
          search: parseListSearch(url),
          sort,
          direction,
          comparison,
          current: comparison.current,
          reference: comparison.reference,
        }
      : {
          mode: "breakdown" as const,
          dimension,
          limit,
          search: parseListSearch(url),
          sort: { key: sort, direction },
          page: { limit, ...(cursor ? { cursor } : {}) },
        }),
  } as CanonicalDimensionQuery;
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "dimension",
    query,
  );
  if (!result.ok) return queryErrorResponse(result.error);
  if (comparison && result.data && typeof result.data === "object") {
    return jsonResponseWith(ctx!, {
      ok: true,
      ...(result.data as { readonly data?: unknown }),
    });
  }
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
