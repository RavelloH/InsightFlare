import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  type CanonicalChannelsQuery,
  type CanonicalDimensionQuery,
  type FilterDocument,
  type OverviewTableComparisonQuery,
  type OverviewTabResult,
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
export type OverviewTab =
  | "page.path"
  | "page.query"
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
  const rawSort = url.searchParams.get("sort");
  if (rawSort !== null && rawSort !== "views" && rawSort !== "visitors") {
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
  const sort = rawSort ?? "views";
  const direction = rawDirection ?? "desc";
  const compare = url.searchParams.get("compare");
  const compareFilterParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.startsWith("compareFilter[")) {
      compareFilterParams.append(
        `filter${key.slice("compareFilter".length)}`,
        value,
      );
    }
  }
  if (compare !== null && compare !== "same" && compare !== "previous") {
    return badRequest("Invalid comparison", "invalid-input");
  }
  let comparison: OverviewTableComparisonQuery | undefined;
  let currentComparisonFilters: FilterDocument = filters;
  let referenceComparisonFilters: FilterDocument = filters;
  if (compare === "same" || compare === "previous") {
    referenceComparisonFilters = compareFilterParams.size
      ? parseFilterUrlForAudience(
          queryContext.policy.audience,
          compareFilterParams,
        )
      : compare === "previous"
        ? filters
        : ({ version: 1, root: null } as FilterDocument);
    if (compare === "same" && !referenceComparisonFilters.root) {
      comparison = undefined;
    } else {
      const referenceWindow =
        compare === "previous" ? previousComparableWindow(window) : window;
      if (tab === "geo.country") {
        currentComparisonFilters = withoutGeoFilter(currentComparisonFilters);
        referenceComparisonFilters = withoutGeoFilter(
          referenceComparisonFilters,
        );
      }
      comparison = {
        current: {
          time: queryWindowToTime(window),
          filters: currentComparisonFilters,
        },
        reference: {
          time: queryWindowToTime(referenceWindow),
          filters: referenceComparisonFilters,
        },
        metric:
          url.searchParams.get("metric") === "visitors"
            ? "visitors"
            : url.searchParams.get("metric") === "sessions"
              ? "sessions"
              : "views",
        sortBy:
          url.searchParams.get("sortBy") === "reference"
            ? "reference"
            : url.searchParams.get("sortBy") === "change"
              ? "change"
              : "current",
        direction,
      };
    }
  }
  const query: CanonicalDimensionQuery = {
    context: queryContext,
    time: queryWindowToTime(window),
    filters,
    mode: "overview-tab" as const,
    tab,
    limit: parseLimit(url, 100, 200),
    cursor: url.searchParams.get("cursor") ?? "",
    search: parseListSearch(url),
    sort,
    direction,
    ...(comparison
      ? {
          comparison,
          current: comparison.current,
          reference: comparison.reference,
        }
      : {}),
  };
  const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId });
  const result =
    tab === "source.channel"
      ? await runtime.execute("channels", {
          ...query,
          tab: "source.channel",
        } satisfies CanonicalChannelsQuery)
      : await runtime.execute("dimension", query);
  if (!result.ok) return queryErrorResponse(result.error);
  const data = result.data as OverviewTabResult;
  return jsonResponseWith(ctx!, { ok: true, ...data });
}
