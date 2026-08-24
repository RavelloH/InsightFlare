import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  parseBooleanSearchParam,
  parseLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
  withoutGeoFilter,
} from "./core";
import { queryGeoPointAggregate } from "./journeys";
import { toQueryTime } from "./overview-contract-adapter";

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
  const result = await executeTypedApplicationOperation<
    Omit<Awaited<ReturnType<typeof queryGeoPointAggregate>>, "points"> & {
      readonly data: Awaited<
        ReturnType<typeof queryGeoPointAggregate>
      >["points"];
    }
  >(
    "geo-points",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("geo-points", async () => {
      const aggregate = await queryGeoPointAggregate(
        env,
        siteId,
        window,
        filters,
        parseLimit(url, 5000, 20000),
      );
      return {
        value: {
          data: aggregate.points,
          countryCounts: aggregate.countryCounts,
          regionCounts: aggregate.regionCounts,
          cityCounts: aggregate.cityCounts,
        },
      };
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
