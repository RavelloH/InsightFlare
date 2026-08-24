import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  mapDimensionRows,
  parseLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
  withoutGeoFilter,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { utmDimensionDefinition } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { queryDimensionAggregate } from "@/lib/edge/analytics/providers/d1/internal/pages";
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

function dimensionDefinition(key: SimpleDimensionKey): {
  readonly expression: string;
  readonly ignoreGeo: boolean;
} {
  if (key === "country") return { expression: "country", ignoreGeo: true };
  if (key === "page.query") {
    return { expression: "query_string", ignoreGeo: false };
  }
  if (key === "page.hash") {
    return { expression: "hash_fragment", ignoreGeo: false };
  }
  const utmKey = key.slice("utm.".length) as
    | "source"
    | "medium"
    | "campaign"
    | "term"
    | "content";
  return {
    expression: utmDimensionDefinition(utmKey).labelExpr,
    ignoreGeo: false,
  };
}

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
  const definition = dimensionDefinition(dimension);
  const rawFilters = parseFilterUrlForAudience(
    queryContext.policy.audience,
    url,
  );
  const filters = definition.ignoreGeo
    ? withoutGeoFilter(rawFilters)
    : rawFilters;
  const result = await executeTypedApplicationOperation<
    ReturnType<typeof mapDimensionRows>
  >(
    "dimension",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("dimension", async () => ({
      value: mapDimensionRows(
        await queryDimensionAggregate(
          env,
          siteId,
          window,
          filters,
          parseLimit(url, 20, 200),
          definition.expression,
        ),
      ),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
