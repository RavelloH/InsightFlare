import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import type {
  FilterValuesResult,
  PageItem,
  PagesResult,
  ReferrerItem,
  ReferrersResult,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  geoTabLabel,
  mapDimensionRows,
  mapGeoTabs,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  regionValueExpr,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { querySessionBoundaryDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryFilterValuesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  queryDimensionAggregate,
  queryPagesAggregate,
  queryPagesDashboard,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";

import {
  type D1SiteQueryRuntimeOptions,
  numberField,
  query,
  type RuntimeQuery,
  stringField,
  timeWindow,
} from "./shared";

export async function overviewTabData(
  options: D1SiteQueryRuntimeOptions,
  request: RuntimeQuery,
): Promise<Readonly<{ data: readonly unknown[] }>> {
  const tab = stringField(request, "tab");
  const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
  const window = timeWindow(request.time);
  const limit = numberField(request, "limit", 100);
  const kind = tab.split(".")[0];
  if (kind === "source") {
    const rows = await queryReferrerAggregate(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      tab === "source.link",
    );
    return {
      data: rows.map((row) => ({
        label: row.referrer,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
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
            options.env,
            options.siteId,
            window,
            filters,
            limit,
            pageTab,
          )
        : await queryDimensionAggregate(
            options.env,
            options.siteId,
            window,
            filters,
            limit,
            { path: "pathname", title: "title", hostname: "hostname" }[
              pageTab
            ]!,
            { excludeEmpty: true },
          );
    return { data: mapTabs(rows) };
  }
  if (kind === "client") {
    const clientTab = tab.slice("client.".length) as
      | "browser"
      | "osVersion"
      | "deviceType"
      | "language"
      | "screenSize";
    const rows = await queryDimensionAggregate(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      clientDimensionDefinition(clientTab).labelExpr,
      { excludeEmpty: true },
    );
    return { data: mapTabs(rows.map((row) => ({ ...row, visitors: 0 }))) };
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
    options.env,
    options.siteId,
    window,
    filters,
    limit,
    expression,
    { excludeEmpty: true },
  );
  return {
    data: mapGeoTabs(
      rows.map((row) => ({
        ...row,
        label: geoTabLabel(row.value, geoTab),
      })),
    ),
  };
}

export function dimensionExpression(dimension: string): string {
  if (dimension === "country") return "country";
  if (dimension === "page.query") return "query_string";
  if (dimension === "page.hash") return "hash_fragment";
  if (dimension.startsWith("utm.")) {
    const key = dimension.slice("utm.".length) as
      | "source"
      | "medium"
      | "campaign"
      | "term"
      | "content";
    return utmDimensionDefinition(key).labelExpr;
  }
  return dimension;
}

export function registerSiteContractProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "dimension",
      typedQueryProvider<
        | ReturnType<typeof mapDimensionRows>
        | Readonly<{ data: readonly unknown[] }>
      >(async (input) => {
        const request = query(input!);
        if (request.tab) {
          return { value: await overviewTabData(options, request) };
        }
        const rows = await queryDimensionAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          numberField(request, "limit", 20),
          dimensionExpression(stringField(request, "dimension")),
        );
        return { value: mapDimensionRows(rows) };
      }),
    )
    .register(
      "geo-points",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const aggregate = await queryGeoPointAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          numberField(request, "limit", 5000),
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
    )
    .register(
      "channels",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const rows = await queryChannelAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          numberField(request, "limit", 100),
        );
        return {
          value: {
            data: rows.map((row) => ({
              label: row.channel,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            })),
          },
        };
      }),
    )
    .register(
      "filter-values",
      typedQueryProvider<FilterValuesResult>(async (input) => {
        const request = query(input!);
        const field = stringField(request, "field");
        const rows = await queryFilterValuesFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          field,
          numberField(request, "limit", 50),
          typeof request.search === "string" ? request.search : undefined,
        );
        return {
          value: {
            field,
            data: rows.map((row) => ({
              value: row.value,
              label: row.value,
              occurrences: row.occurrences,
            })),
          },
        };
      }),
    )
    .register(
      "retention",
      typedQueryProvider<RetentionResult>(async (input) => {
        const request = query(input!);
        return {
          value: await queryRetentionFromD1(
            options.env,
            options.siteId,
            timeWindow(request.time),
            request.filters ?? EMPTY_FILTER_DOCUMENT,
            parseRetentionGranularity(
              stringField(request, "granularity", "week"),
            ),
          ),
        };
      }),
    )
    .register(
      "performance",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryPerformanceDashboardFromD1(
            options.env,
            options.siteId,
            timeWindow(request.time),
            request.interval as never,
            request.filters ?? EMPTY_FILTER_DOCUMENT,
            numberField(request, "limit", 18),
          ),
        };
      }),
    )
    .register(
      "pages",
      typedQueryProvider<
        PagesResult | Awaited<ReturnType<typeof queryPageTabsAggregate>>
      >(async (input) => {
        const request = query(input!);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        if (request.variant === "tabs") {
          return {
            value: await queryPageTabsAggregate(
              options.env,
              options.siteId,
              timeWindow(request.time),
              filters,
              numberField(request, "limit", 20),
            ),
          };
        }
        const rows = await queryPagesAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          filters,
          numberField(request, "limit", 20),
          request.includeDetails === true,
        );
        return {
          value: {
            items: rows.map(
              (row): PageItem => ({
                pathname: row.pathname,
                query: row.query,
                hash: row.hash,
                views: row.views,
                sessions: row.sessions,
              }),
            ),
          },
          source: "raw",
        };
      }),
    )
    .register(
      "referrers",
      typedQueryProvider<ReferrersResult>(async (input) => {
        const request = query(input!);
        const rows = await queryReferrerAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          numberField(request, "limit", 20),
          request.includeFullUrl === true,
        );
        return {
          value: {
            items: rows.map(
              (row): ReferrerItem => ({
                referrer: row.referrer,
                views: row.views,
                sessions: row.sessions,
                visitors: row.visitors,
              }),
            ),
          },
          source: "raw",
        };
      }),
    )
    .register(
      "pages-dashboard",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryPagesDashboard(options.env, options.siteId, {
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            interval: request.interval as never,
            page: numberField(request, "page", 1),
            pageSize: numberField(request, "pageSize", 12),
            offset: numberField(request, "offset", 0),
          }),
        };
      }),
    );
}
