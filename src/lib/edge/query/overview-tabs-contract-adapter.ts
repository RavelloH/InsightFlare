import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  geoTabLabel,
  jsonResponseWith,
  mapGeoTabs,
  mapTabs,
  parseFilters,
  parseLimit,
  parseWindow,
  type ResponseContext,
  withoutGeoFilter,
} from "./core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  regionValueExpr,
} from "./core-dimensions";
import { querySessionBoundaryDimensionFromD1 } from "./dimensions";
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";
import { queryDimensionAggregate, queryReferrerAggregate } from "./pages";

export type OverviewTab =
  | "page.path"
  | "page.title"
  | "page.hostname"
  | "page.entry"
  | "page.exit"
  | "source.domain"
  | "source.link"
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

function category(tab: OverviewTab) {
  return tab.split(".")[0] as "page" | "source" | "client" | "geo";
}

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
  const rawFilters = parseFilters(url);
  const kind = category(tab);
  const filters =
    tab === "geo.country" ? withoutGeoFilter(rawFilters) : rawFilters;
  const operation = kind === "source" ? "referrers" : "dimension";
  const result = await executeQueryOperation(
    operation,
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
      const limit = parseLimit(url, 100, 200);
      if (kind === "source") {
        const rows = await queryReferrerAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
          tab === "source.link",
        );
        return {
          value: {
            data: rows.map((row) => ({
              label: row.referrer,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            })),
          },
        };
      }
      if (kind === "page") {
        const pageTab = tab.slice("page.".length) as
          | "path"
          | "title"
          | "hostname"
          | "entry"
          | "exit";
        const rows =
          pageTab === "entry" || pageTab === "exit"
            ? await querySessionBoundaryDimensionFromD1(
                env,
                siteId,
                window,
                filters,
                limit,
                pageTab,
              )
            : await queryDimensionAggregate(
                env,
                siteId,
                window,
                filters,
                limit,
                { path: "pathname", title: "title", hostname: "hostname" }[
                  pageTab
                ]!,
                { excludeEmpty: true },
              );
        return { value: { data: mapTabs(rows) } };
      }
      if (kind === "client") {
        const clientTab = tab.slice("client.".length) as
          | "browser"
          | "osVersion"
          | "deviceType"
          | "language"
          | "screenSize";
        const rows = await queryDimensionAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
          clientDimensionDefinition(clientTab).labelExpr,
          { excludeEmpty: true },
        );
        return {
          value: {
            data: mapTabs(rows.map((row) => ({ ...row, visitors: 0 }))),
          },
        };
      }
      const geoTab = tab.slice("geo.".length) as
        | "country"
        | "region"
        | "city"
        | "continent"
        | "timezone"
        | "organization";
      const expression = {
        country: "country",
        region: regionValueExpr(),
        city: cityValueExpr(),
        continent: "continent",
        timezone: "timezone",
        organization: "as_organization",
      }[geoTab];
      const rows = await queryDimensionAggregate(
        env,
        siteId,
        window,
        filters,
        limit,
        expression,
        { excludeEmpty: true },
      );
      return {
        value: {
          data: mapGeoTabs(
            rows.map((row) => ({
              ...row,
              label: geoTabLabel(row.value, geoTab),
            })),
          ),
        },
      };
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
