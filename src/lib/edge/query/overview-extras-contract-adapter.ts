import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  dedupeFilterOptions,
  jsonResponseWith,
  mapDimensionRowsToFilterOptions,
  mapGeoRowsToFilterOptions,
  mapReferrerRowsToFilterOptions,
  parseBooleanSearchParam,
  parseFilterOptionKey,
  parseFilters,
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
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";
import {
  queryDimensionAggregate,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "./pages";

/** Minimal typed boundary for the existing filter protocol. Filter AST meaning
 * remains deliberately delegated to the later filter redesign. */
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
  const filters = withoutFilterKey(parseFilters(url), filterKey);
  const result = await executeQueryOperation(
    "filter-options",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
      const limit = parseLimit(url, 200, 500);
      let data = [] as ReturnType<typeof mapDimensionRowsToFilterOptions>;
      if (
        filterKey === "country" ||
        filterKey === "device" ||
        filterKey === "browser"
      ) {
        const expression = {
          country: "country",
          device: "device_type",
          browser: "browser",
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
        ["path", "title", "hostname", "entry", "exit"].includes(filterKey)
      ) {
        const tabs = await queryPageTabsAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const rows = (
          tabs as unknown as Record<
            string,
            Parameters<typeof mapDimensionRowsToFilterOptions>[0]
          >
        )[filterKey];
        data = mapDimensionRowsToFilterOptions(rows);
      } else if (filterKey === "sourceDomain" || filterKey === "sourceLink") {
        data = mapReferrerRowsToFilterOptions(
          await queryReferrerAggregate(
            env,
            siteId,
            window,
            filters,
            limit,
            filterKey === "sourceLink",
          ),
        );
      } else if (
        [
          "clientBrowser",
          "clientOsVersion",
          "clientDeviceType",
          "clientLanguage",
          "clientScreenSize",
        ].includes(filterKey)
      ) {
        const tabs = await buildOverviewClientDimensionTabs(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const key = {
          clientBrowser: "browser",
          clientOsVersion: "osVersion",
          clientDeviceType: "deviceType",
          clientLanguage: "language",
          clientScreenSize: "screenSize",
        }[
          filterKey as
            | "clientBrowser"
            | "clientOsVersion"
            | "clientDeviceType"
            | "clientLanguage"
            | "clientScreenSize"
        ];
        const rows = (
          tabs as unknown as Record<
            string,
            Parameters<typeof mapDimensionRowsToFilterOptions>[0]
          >
        )[key];
        data = mapDimensionRowsToFilterOptions(rows);
      } else if (filterKey === "geo") {
        const tabs = await buildOverviewGeoDimensionTabs(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        data = dedupeFilterOptions([
          ...mapGeoRowsToFilterOptions(tabs.country, "country"),
          ...mapGeoRowsToFilterOptions(tabs.region, "region"),
          ...mapGeoRowsToFilterOptions(tabs.city, "city"),
        ]);
      } else if (
        ["geoContinent", "geoTimezone", "geoOrganization"].includes(filterKey)
      ) {
        const tabs = await buildOverviewGeoDimensionTabs(
          env,
          siteId,
          window,
          filters,
          limit,
        );
        const key = {
          geoContinent: "continent",
          geoTimezone: "timezone",
          geoOrganization: "organization",
        }[filterKey as "geoContinent" | "geoTimezone" | "geoOrganization"];
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
    ? parseFilters(url)
    : withoutGeoFilter(parseFilters(url));
  const result = await executeQueryOperation(
    "geo-points",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
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
