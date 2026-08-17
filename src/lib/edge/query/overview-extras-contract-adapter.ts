import { parseFilterUrlForAudience } from "@/lib/edge/query-contract";
import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  mapDimensionRowsToFilterOptions,
  mapReferrerRowsToFilterOptions,
  parseBooleanSearchParam,
  parseFilterOptionKey,
  parseLimit,
  parseWindow,
  type ResponseContext,
  withoutFilterKey,
  withoutGeoFilter,
} from "./core";
import { queryGeoPointAggregate } from "./journeys";
import {
  buildOverviewClientDimensionTabs,
  buildOverviewGeoDimensionTabs,
} from "./overview";
import { toQueryTime } from "./overview-contract-adapter";
import {
  queryDimensionAggregate,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "./pages";

export async function handleFilterOptionsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const filterKey = parseFilterOptionKey(url);
  if (!filterKey) return badRequest("Invalid filter key");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = withoutFilterKey(
    parseFilterUrlForAudience(queryContext.policy.audience, url),
    filterKey,
  );
  const result = await executeQueryOperation(
    "filter-options",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    async () => {
      const limit = parseLimit(url, 200, 500);
      let data = [] as ReturnType<typeof mapDimensionRowsToFilterOptions>;
      if (
        filterKey === "geo.country" ||
        filterKey === "client.deviceType" ||
        filterKey === "client.browser"
      ) {
        const expression = {
          "geo.country": "country",
          "client.deviceType": "device_type",
          "client.browser": "browser",
        }[filterKey];
        data = mapDimensionRowsToFilterOptions(
          await queryDimensionAggregate(
            env,
            siteId,
            window,
            filters,
            limit,
            expression,
          ),
        );
      } else if (
        [
          "page.path",
          "page.title",
          "page.hostname",
          "session.entryPath",
          "session.exitPath",
        ].includes(filterKey)
      ) {
        const tabs = await queryPageTabsAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const key = (
          {
            "page.path": "path",
            "page.title": "title",
            "page.hostname": "hostname",
            "session.entryPath": "entry",
            "session.exitPath": "exit",
          } as Partial<Record<typeof filterKey, string>>
        )[filterKey];
        if (!key) return { value: { data } };
        const rows = (
          tabs as unknown as Record<
            string,
            Parameters<typeof mapDimensionRowsToFilterOptions>[0]
          >
        )[key];
        data = mapDimensionRowsToFilterOptions(rows);
      } else if (
        filterKey === "referrer.domain" ||
        filterKey === "referrer.url"
      ) {
        data = mapReferrerRowsToFilterOptions(
          await queryReferrerAggregate(
            env,
            siteId,
            window,
            filters,
            limit,
            filterKey === "referrer.url",
          ),
        );
      } else if (
        ["client.osVersion", "client.language", "client.screenSize"].includes(
          filterKey,
        )
      ) {
        const tabs = await buildOverviewClientDimensionTabs(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const key = {
          "client.osVersion": "osVersion",
          "client.language": "language",
          "client.screenSize": "screenSize",
        }[
          filterKey as
            | "client.osVersion"
            | "client.language"
            | "client.screenSize"
        ];
        const rows = (
          tabs as unknown as Record<
            string,
            Parameters<typeof mapDimensionRowsToFilterOptions>[0]
          >
        )[key];
        data = mapDimensionRowsToFilterOptions(rows);
      } else if (
        [
          "geo.region",
          "geo.city",
          "geo.continent",
          "geo.timeZone",
          "geo.organization",
        ].includes(filterKey)
      ) {
        const tabs = await buildOverviewGeoDimensionTabs(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const key = {
          "geo.region": "region",
          "geo.city": "city",
          "geo.continent": "continent",
          "geo.timeZone": "timezone",
          "geo.organization": "organization",
        }[
          filterKey as
            | "geo.region"
            | "geo.city"
            | "geo.continent"
            | "geo.timeZone"
            | "geo.organization"
        ];
        const rows = (
          tabs as unknown as Record<
            string,
            Parameters<typeof mapDimensionRowsToFilterOptions>[0]
          >
        )[key];
        data = mapDimensionRowsToFilterOptions(rows);
      }
      return { value: { data } };
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

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
  const result = await executeQueryOperation(
    "geo-points",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    async () => {
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
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
