import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import type {
  FilterValuesResult,
  PageItem,
  PagesResult,
  ReferrerItem,
  ReferrersResult,
  ReferrerSummaryResult,
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
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  queryDimensionPageFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  queryFilterValuesFromD1,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
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
  queryPagesPageFromD1,
  queryPageTabsAggregate,
  queryReferrerAggregate,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import {
  decodePagesCursor,
  decodeReferrersCursor,
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
): Promise<
  Readonly<{ data: { items: readonly unknown[]; pagination: unknown } }>
> {
  const tab = stringField(request, "tab");
  const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
  const window = timeWindow(request.time);
  const limit = numberField(request, "limit", 100);
  const cursorText = stringField(request, "cursor") || null;
  const audience = request.context.policy.audience;
  const sortBy =
    stringField(request, "sort") === "visitors" ? "visitors" : "views";
  const sortDirection =
    stringField(request, "direction") === "asc" ? "asc" : "desc";
  const search = stringField(request, "search") || undefined;
  const kind = tab.split(".")[0];
  if (tab === "source.channel") {
    const selectExpr = buildTrafficChannelSqlExpression();
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      selectExpr,
      search,
      cursorText,
      audience,
      sortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new Error("invalid-cursor");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selectExpr,
      {
        excludeEmpty: true,
        search,
        sortBy,
        sortDirection,
      },
      cursor,
      undefined,
      audience,
    );
    return {
      data: {
        items: mapTabs([...page.items]),
        pagination: page.pagination,
      },
    };
  }
  if (kind === "source") {
    const includeFullUrl = tab === "source.link";
    const cursor = await decodeReferrersCursor(
      options.env,
      options.siteId,
      window,
      filters,
      includeFullUrl,
      search,
      cursorText,
      audience,
      sortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new Error("invalid-cursor");
    const page = await queryReferrersPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      includeFullUrl,
      search,
      cursor,
      undefined,
      audience,
      sortBy,
      sortDirection,
    );
    return {
      data: {
        items: page.items.map((row) => ({
          label: row.referrer,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        })),
        pagination: page.pagination,
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
    if (pageTab === "entry" || pageTab === "exit") {
      const pageKind = pageTab === "entry" ? "entry" : "exit";
      const cursor = await decodeSessionPathDimensionCursor(
        options.env,
        options.siteId,
        window,
        filters,
        pageKind,
        undefined,
        cursorText,
        audience,
      );
      if (cursorText && !cursor) throw new Error("invalid-cursor");
      const page = await querySessionPathDimensionPageFromD1(
        options.env,
        options.siteId,
        window,
        filters,
        limit,
        pageKind,
        undefined,
        undefined,
        cursor,
        audience,
      );
      return {
        data: {
          items: mapTabs([...page.items]),
          pagination: page.pagination,
        },
      };
    }
    const selectExpr = {
      path: "pathname",
      title: "title",
      hostname: "hostname",
    }[pageTab]!;
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      selectExpr,
      undefined,
      cursorText,
      audience,
    );
    if (cursorText && !cursor) throw new Error("invalid-cursor");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selectExpr,
      { excludeEmpty: true },
      cursor,
      undefined,
      audience,
    );
    return {
      data: { items: mapTabs([...page.items]), pagination: page.pagination },
    };
  }
  if (kind === "client") {
    const clientTab = tab.slice("client.".length) as
      | "browser"
      | "osVersion"
      | "deviceType"
      | "language"
      | "screenSize";
    const selectExpr = clientDimensionDefinition(clientTab).labelExpr;
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      selectExpr,
      undefined,
      cursorText,
      audience,
    );
    if (cursorText && !cursor) throw new Error("invalid-cursor");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selectExpr,
      { excludeEmpty: true },
      cursor,
      undefined,
      audience,
    );
    return {
      data: {
        items: mapTabs(page.items.map((row) => ({ ...row, visitors: 0 }))),
        pagination: page.pagination,
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
  const cursor = await decodeDimensionCursor(
    options.env,
    options.siteId,
    window,
    filters,
    expression,
    undefined,
    cursorText,
    audience,
  );
  if (cursorText && !cursor) throw new Error("invalid-cursor");
  const page = await queryDimensionPageFromD1(
    options.env,
    options.siteId,
    window,
    filters,
    limit,
    expression,
    { excludeEmpty: true },
    cursor,
    undefined,
    audience,
  );
  return {
    data: {
      items: mapGeoTabs(
        page.items.map((row) => ({
          ...row,
          label: geoTabLabel(row.value, geoTab),
        })),
      ),
      pagination: page.pagination,
    },
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
        | Awaited<ReturnType<typeof overviewTabData>>
        | Readonly<{
            items: readonly unknown[];
            pagination: unknown;
          }>
      >(async (input) => {
        const request = query(input!);
        if (request.tab) {
          return { value: await overviewTabData(options, request) };
        }
        const pageRequest =
          request.page && typeof request.page === "object"
            ? (request.page as {
                limit?: unknown;
                cursor?: unknown;
              })
            : null;
        if (pageRequest) {
          const window = timeWindow(request.time);
          const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
          const limit =
            typeof pageRequest.limit === "number" &&
            Number.isFinite(pageRequest.limit)
              ? pageRequest.limit
              : numberField(request, "limit", 20);
          const cursorText =
            typeof pageRequest.cursor === "string" ? pageRequest.cursor : null;
          const selectExpr = dimensionExpression(
            stringField(request, "dimension"),
          );
          const cursor = await decodeDimensionCursor(
            options.env,
            options.siteId,
            window,
            filters,
            selectExpr,
            undefined,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new Error("invalid-cursor");
          const page = await queryDimensionPageFromD1(
            options.env,
            options.siteId,
            window,
            filters,
            limit,
            selectExpr,
            { excludeEmpty: false },
            cursor,
            undefined,
            request.context.policy.audience,
          );
          return {
            value: {
              items: mapDimensionRows([...page.items]),
              pagination: page.pagination,
            },
          };
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
      typedQueryProvider<unknown>(async (input) => {
        const request = query(input!);
        if (request.tab === "source.channel") {
          const window = timeWindow(request.time);
          const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
          const limit = numberField(request, "limit", 100);
          const cursorText = stringField(request, "cursor") || null;
          const selectExpr = buildTrafficChannelSqlExpression();
          const cursor = await decodeDimensionCursor(
            options.env,
            options.siteId,
            window,
            filters,
            selectExpr,
            undefined,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new Error("invalid-cursor");
          const page = await queryDimensionPageFromD1(
            options.env,
            options.siteId,
            window,
            filters,
            limit,
            selectExpr,
            { excludeEmpty: true },
            cursor,
            undefined,
            request.context.policy.audience,
          );
          return {
            value: {
              data: {
                items: mapTabs([...page.items]),
                pagination: page.pagination,
              },
            },
          };
        }
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
        const pageValue = request.page;
        const page =
          pageValue && typeof pageValue === "object"
            ? (pageValue as { limit?: unknown; cursor?: unknown })
            : null;
        const limit = page
          ? typeof page.limit === "number" && Number.isFinite(page.limit)
            ? page.limit
            : 50
          : numberField(request, "limit", 50);
        const cursor =
          page && typeof page.cursor === "string" ? page.cursor : null;
        const rows = page
          ? await queryFilterValuesPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              field,
              limit,
              cursor,
              typeof request.search === "string" ? request.search : undefined,
              request.context.policy.audience,
            )
          : null;
        const aggregateRows = rows
          ? rows.items
          : await queryFilterValuesFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              field,
              limit,
              typeof request.search === "string" ? request.search : undefined,
            );
        return {
          value: {
            field,
            data: {
              items: aggregateRows.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: rows?.pagination ?? {
                limit,
                returned: aggregateRows.length,
                hasMore: false,
                nextCursor: null,
              },
            },
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
        const rawPage = request.page;
        const page =
          rawPage && typeof rawPage === "object"
            ? (rawPage as { limit?: unknown; cursor?: unknown })
            : null;
        if (page) {
          const limit =
            typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : 20;
          const cursorText =
            typeof page.cursor === "string" ? page.cursor : null;
          const cursor = await decodePagesCursor(
            options.env,
            options.siteId,
            timeWindow(request.time),
            filters,
            request.includeDetails === true,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new Error("invalid-cursor");
          return {
            value: await queryPagesPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              filters,
              limit,
              request.includeDetails === true,
              cursor,
              request.context.policy.audience,
            ),
            source: "raw",
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
      typedQueryProvider<ReferrersResult | ReferrerSummaryResult>(
        async (input) => {
          const request = query(input!);
          if (request.variant === "summary") {
            const topN = numberField(
              request,
              "topN",
              numberField(request, "limit", 5),
            );
            return {
              value: await queryReferrerSummaryFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                topN,
              ),
              source: "raw",
            };
          }
          const rawPage = request.page;
          const page =
            rawPage && typeof rawPage === "object"
              ? (rawPage as { limit?: unknown; cursor?: unknown })
              : null;
          if (page) {
            const limit =
              typeof page.limit === "number" && Number.isFinite(page.limit)
                ? page.limit
                : 20;
            const cursorText =
              typeof page.cursor === "string" ? page.cursor : null;
            const sortBy =
              stringField(request, "sort") === "visitors"
                ? "visitors"
                : "views";
            const sortDirection =
              stringField(request, "direction") === "asc" ? "asc" : "desc";
            const window = timeWindow(request.time);
            const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
            const cursor = await decodeReferrersCursor(
              options.env,
              options.siteId,
              window,
              filters,
              request.includeFullUrl === true,
              typeof request.search === "string" ? request.search : undefined,
              cursorText,
              request.context.policy.audience,
              sortBy,
              sortDirection,
            );
            if (cursorText && !cursor) throw new Error("invalid-cursor");
            return {
              value: await queryReferrersPageFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                limit,
                request.includeFullUrl === true,
                typeof request.search === "string" ? request.search : undefined,
                cursor,
                undefined,
                request.context.policy.audience,
                sortBy,
                sortDirection,
              ),
              source: "raw",
            };
          }
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
        },
      ),
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
