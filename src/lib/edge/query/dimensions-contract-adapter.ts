import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  mapDimensionRows,
  parseFilters,
  parseLimit,
  parseWindow,
  type ResponseContext,
  withoutGeoFilter,
} from "./core";
import { utmDimensionDefinition } from "./core-dimensions";
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";
import { queryDimensionAggregate } from "./pages";

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
  const rawFilters = parseFilters(url);
  const filters = definition.ignoreGeo
    ? withoutGeoFilter(rawFilters)
    : rawFilters;
  const result = await executeQueryOperation(
    "dimension",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
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
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
