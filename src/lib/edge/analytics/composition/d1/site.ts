import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import type {
  ChannelOverviewTabQuery,
  DimensionOverviewTabQuery,
  OverviewTableComparisonQuery,
  OverviewTabResult,
  PerformanceQuery,
  QueryInput,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import {
  geoTabLabel,
  mapDimensionRows,
  mapGeoTabs,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  referrerDomainDimensionDefinition,
  regionValueExpr,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  queryDimensionPageFromD1,
  querySessionBoundaryDimensionFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryEventTypeAggregate } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  queryPagesPageFromD1,
  queryPagesWithTabsFromD1,
  queryPageTabsAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { decodePagesCursor } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import {
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import { decodeReferrersCursor } from "@/lib/edge/analytics/providers/d1/internal/referrers";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import { InvalidCursorError } from "@/lib/pagination";

import {
  type D1SiteRuntimeBindings,
  numberField,
  stringField,
  timeWindow,
} from "./shared";
function overviewTabExpression(tab: string): string | null {
  if (tab === "page.path") return "TRIM(COALESCE(pathname, ''))";
  if (tab === "page.query") return "TRIM(COALESCE(query_string, ''))";
  if (tab === "page.title") return "TRIM(COALESCE(title, ''))";
  if (tab === "page.hostname") return "TRIM(COALESCE(hostname, ''))";
  if (tab === "source.domain")
    return referrerDomainDimensionDefinition().labelExpr;
  if (tab === "source.link") return "TRIM(COALESCE(referrer_url, ''))";
  if (tab === "source.channel") return buildTrafficChannelSqlExpression();
  if (tab.startsWith("client.")) {
    return clientDimensionDefinition(
      tab.slice("client.".length) as
        "browser" | "osVersion" | "deviceType" | "language" | "screenSize",
    ).labelExpr;
  }
  if (tab.startsWith("utm.")) {
    return utmDimensionDefinition(
      tab.slice("utm.".length) as
        "source" | "medium" | "campaign" | "term" | "content",
    ).labelExpr;
  }
  if (tab === "geo.country") return "TRIM(COALESCE(country, ''))";
  if (tab === "geo.region") return regionValueExpr();
  if (tab === "geo.city") return cityValueExpr();
  if (tab === "geo.continent") return "TRIM(COALESCE(continent, ''))";
  if (tab === "geo.timezone") return "TRIM(COALESCE(timezone, ''))";
  if (tab === "geo.organization") return "TRIM(COALESCE(as_organization, ''))";
  return null;
}
function isPerformanceQuery(input: QueryInput): input is PerformanceQuery {
  if (!("time" in input) || !("mode" in input)) return false;
  if (input.mode === "summary") return true;
  if (input.mode === "dashboard" || input.mode === "timeseries") {
    return (
      "interval" in input &&
      ["minute", "hour", "day", "week", "month"].includes(
        String(input.interval),
      )
    );
  }
  return (
    input.mode === "breakdown" &&
    "dimension" in input &&
    typeof input.dimension === "string" &&
    "metric" in input &&
    ["ttfb", "fcp", "lcp", "cls", "inp"].includes(String(input.metric))
  );
}
export async function overviewTabData(
  options: D1SiteRuntimeBindings,
  request: DimensionOverviewTabQuery | ChannelOverviewTabQuery,
): Promise<OverviewTabResult> {
  const tab = stringField(request, "tab");
  const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
  const window = timeWindow(request.time);
  const limit = numberField(request, "limit", 100);
  const cursorText = stringField(request, "cursor") || null;
  const audience = request.context.policy.audience;
  const sortValue = stringField(request, "sort");
  const sortBy =
    sortValue === "visitors" || sortValue === "sessions" ? sortValue : "views";
  const sortDirection =
    stringField(request, "direction") === "asc" ? "asc" : "desc";
  const search = stringField(request, "search") || undefined;
  const kind = tab.split(".")[0];
  const comparison =
    request.comparison && typeof request.comparison === "object"
      ? (request.comparison as OverviewTableComparisonQuery)
      : null;
  const comparisonCurrent = request.current ?? null;
  const comparisonReference = request.reference ?? null;
  if (
    comparison &&
    comparisonCurrent?.time &&
    comparisonReference?.time &&
    (tab === "page.entry" || tab === "page.exit")
  ) {
    const pageKind = tab === "page.entry" ? "entry" : "exit";
    const currentWindow = timeWindow(comparisonCurrent.time);
    const referenceWindow = timeWindow(comparisonReference.time);
    const currentFilters = comparisonCurrent.filters ?? EMPTY_FILTER_DOCUMENT;
    const referenceFilters =
      comparisonReference.filters ?? EMPTY_FILTER_DOCUMENT;
    const cursor = await decodeComparisonDimensionCursor(
      options.env,
      options.siteId,
      currentWindow,
      currentFilters,
      referenceWindow,
      referenceFilters,
      `session.${pageKind}`,
      search,
      cursorText,
      audience,
      comparison.metric,
      comparison.sortBy,
      comparison.direction,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryComparisonSessionPathPageFromD1(
      options.env,
      options.siteId,
      currentWindow,
      currentFilters,
      referenceWindow,
      referenceFilters,
      limit,
      pageKind,
      {
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
        search,
      },
      cursor,
      audience,
    );
    return {
      data: {
        items: page.items.map((row) => ({
          key: row.key,
          value: row.key,
          label: row.key,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
          reference: row.reference,
          change: row.change,
        })),
        pagination: page.pagination,
      },
    };
  }
  if (comparison && comparisonCurrent?.time && comparisonReference?.time) {
    const expression = overviewTabExpression(tab);
    if (expression) {
      const currentWindow = timeWindow(comparisonCurrent.time);
      const referenceWindow = timeWindow(comparisonReference.time);
      const currentFilters = comparisonCurrent.filters ?? EMPTY_FILTER_DOCUMENT;
      const referenceFilters =
        comparisonReference.filters ?? EMPTY_FILTER_DOCUMENT;
      const cursor = await decodeComparisonDimensionCursor(
        options.env,
        options.siteId,
        currentWindow,
        currentFilters,
        referenceWindow,
        referenceFilters,
        expression,
        search,
        cursorText,
        audience,
        comparison.metric,
        comparison.sortBy,
        comparison.direction,
      );
      if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
      const page = await queryComparisonDimensionPageFromD1(
        options.env,
        options.siteId,
        currentWindow,
        currentFilters,
        referenceWindow,
        referenceFilters,
        limit,
        expression,
        {
          metric: comparison.metric,
          sortBy: comparison.sortBy,
          direction: comparison.direction,
          search,
        },
        cursor,
        audience,
      );
      return {
        data: {
          items: page.items.map((row) => ({
            key: row.key,
            value: row.key,
            label: row.key,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
            reference: row.reference,
            change: row.change,
          })),
          pagination: page.pagination,
        },
      };
    }
  }
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
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
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
    const referrerSortBy = sortBy === "visitors" ? "visitors" : "views";
    const cursor = await decodeReferrersCursor(
      options.env,
      options.siteId,
      window,
      filters,
      includeFullUrl,
      search,
      cursorText,
      audience,
      referrerSortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
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
      referrerSortBy,
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
      "path" | "query" | "title" | "hostname" | "entry" | "exit";
    if (pageTab === "entry" || pageTab === "exit") {
      const pageKind = pageTab === "entry" ? "entry" : "exit";
      const cursor = await decodeSessionPathDimensionCursor(
        options.env,
        options.siteId,
        window,
        filters,
        pageKind,
        search,
        cursorText,
        audience,
        sortBy,
        sortDirection,
      );
      if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
      const page = await querySessionPathDimensionPageFromD1(
        options.env,
        options.siteId,
        window,
        filters,
        limit,
        pageKind,
        undefined,
        search,
        cursor,
        audience,
        sortBy,
        sortDirection,
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
      query: "query_string",
      title: "title",
      hostname: "hostname",
    }[pageTab]!;
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
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selectExpr,
      { excludeEmpty: true, search, sortBy, sortDirection },
      cursor,
      undefined,
      audience,
    );
    const items =
      pageTab === "query"
        ? page.items.map((row) => ({
            value: row.value,
            label: row.value,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
          }))
        : mapTabs([...page.items]);
    return { data: { items, pagination: page.pagination } };
  }
  if (kind === "client") {
    const clientTab = tab.slice("client.".length) as
      "browser" | "osVersion" | "deviceType" | "language" | "screenSize";
    const selectExpr = clientDimensionDefinition(clientTab).labelExpr;
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
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selectExpr,
      { excludeEmpty: true, search, sortBy, sortDirection },
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
  if (kind === "utm") {
    const expression = overviewTabExpression(tab);
    if (!expression) {
      return {
        data: {
          items: [],
          pagination: {
            limit,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      };
    }
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      expression,
      search,
      cursorText,
      audience,
      sortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      expression,
      { excludeEmpty: false, search, sortBy, sortDirection },
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
  const geoTab = tab.slice("geo.".length) as
    "country" | "region" | "city" | "continent" | "timezone" | "organization";
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
    search,
    cursorText,
    audience,
    sortBy,
    sortDirection,
  );
  if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
  const page = await queryDimensionPageFromD1(
    options.env,
    options.siteId,
    window,
    filters,
    limit,
    expression,
    { excludeEmpty: true, search, sortBy, sortDirection },
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
      "source" | "medium" | "campaign" | "term" | "content";
    return utmDimensionDefinition(key).labelExpr;
  }
  return dimension;
}
export function registerSiteContractProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry
    .register(
      "dimension",
      typedQueryProviderFor("dimension", async (input) => {
        const request = input;
        if (request.mode === "overview-tab") {
          return { value: await overviewTabData(options, request) };
        }
        const pageRequest =
          request.page && typeof request.page === "object"
            ? (request.page as { limit?: unknown; cursor?: unknown })
            : {};
        {
          const window = timeWindow(request.time);
          const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
          const limit =
            typeof pageRequest.limit === "number" &&
            Number.isFinite(pageRequest.limit)
              ? pageRequest.limit
              : numberField(request, "limit", 20);
          const cursorText =
            typeof pageRequest.cursor === "string" ? pageRequest.cursor : null;
          const sortRecord =
            request.sort && typeof request.sort === "object"
              ? (request.sort as { key?: unknown; direction?: unknown })
              : null;
          const sortBy =
            sortRecord?.key === "sessions" || sortRecord?.key === "visitors"
              ? sortRecord.key
              : "views";
          const sortDirection =
            sortRecord?.direction === "asc" ? "asc" : "desc";
          const search =
            typeof request.search === "string" ? request.search : undefined;
          const dimension = stringField(request, "dimension");
          if (dimension === "event.name") {
            const rows = await queryEventTypeAggregate(
              options.env,
              options.siteId,
              window,
              filters,
              limit,
              search,
            );
            return { value: { items: mapDimensionRows(rows) } };
          }
          if (
            dimension === "session.entryPath" ||
            dimension === "session.exitPath"
          ) {
            const rows = await querySessionBoundaryDimensionFromD1(
              options.env,
              options.siteId,
              window,
              filters,
              limit,
              dimension === "session.entryPath" ? "entry" : "exit",
              undefined,
              search,
              sortBy,
              sortDirection,
            );
            return { value: { items: mapDimensionRows(rows) } };
          }
          const selectExpr = dimensionExpression(dimension);
          const cursor = await decodeDimensionCursor(
            options.env,
            options.siteId,
            window,
            filters,
            selectExpr,
            search,
            cursorText,
            request.context.policy.audience,
            sortBy,
            sortDirection,
          );
          if (cursorText && !cursor) throw new InvalidCursorError("dimension");
          const page = await queryDimensionPageFromD1(
            options.env,
            options.siteId,
            window,
            filters,
            limit,
            selectExpr,
            {
              excludeEmpty: false,
              search,
              sortBy,
              sortDirection,
            },
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
      }),
    )
    .register(
      "geo-points",
      typedQueryProviderFor("geo-points", async (input) => {
        const request = input;
        const aggregate = await queryGeoPointAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          numberField(request, "limit", 5000),
        );
        return {
          value: {
            points: aggregate.points,
            countryCounts: aggregate.countryCounts,
            regionCounts: aggregate.regionCounts,
            cityCounts: aggregate.cityCounts,
          },
        };
      }),
    )
    .register(
      "channels",
      typedQueryProviderFor("channels", async (input) => {
        const request = input;
        if (request.mode === "overview-tab") {
          return { value: await overviewTabData(options, request) };
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
            items: rows.map((row) => ({
              channel: row.channel,
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
      typedQueryProviderFor("filter-values", async (input) => {
        const request = input;
        const field = stringField(request, "field");
        const pageValue = request.page;
        const page =
          pageValue && typeof pageValue === "object"
            ? (pageValue as { limit?: unknown; cursor?: unknown })
            : {};
        const limit = page
          ? typeof page.limit === "number" && Number.isFinite(page.limit)
            ? page.limit
            : 50
          : numberField(request, "limit", 50);
        const cursor =
          page && typeof page.cursor === "string" ? page.cursor : null;
        const rows = await queryFilterValuesPageFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          field,
          limit,
          cursor,
          typeof request.search === "string" ? request.search : undefined,
          request.context.policy.audience,
        );
        return {
          value: {
            field,
            data: {
              items: rows.items.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: rows.pagination,
            },
          },
        };
      }),
    )
    .register(
      "retention",
      typedQueryProviderFor("retention", async (input) => {
        const request = input;
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
      typedQueryProviderFor("performance", async (input) => {
        if (!input || !isPerformanceQuery(input)) {
          throw new Error("unsupported-performance-query-mode");
        }
        const request = input;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        switch (request.mode) {
          case "summary":
            return {
              value: await readSitePerformanceSummary({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
              }),
            };
          case "timeseries":
            return {
              value: await readSitePerformanceTimeseries({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
                interval: request.interval,
              }),
            };
          case "breakdown":
            return {
              value: await readSitePerformanceBreakdown({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
                dimension: request.dimension,
                metric: request.metric,
                limit: request.limit ?? 20,
              }),
            };
          case "dashboard":
            return {
              value: await queryPerformanceDashboardFromD1(
                options.env,
                options.siteId,
                window,
                request.interval,
                filters,
                request.limit ?? 18,
              ),
            };
        }
      }),
    )
    .register(
      "pages",
      typedQueryProviderFor("pages", async (input) => {
        const request = input;
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
        if (request.includeTabs === true) {
          const rawPage = request.page;
          const page =
            rawPage && typeof rawPage === "object"
              ? (rawPage as { limit?: unknown; cursor?: unknown })
              : {};
          const limit =
            page &&
            typeof page.limit === "number" &&
            Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
          const cursorText =
            page && typeof page.cursor === "string" ? page.cursor : null;
          const cursor = await decodePagesCursor(
            options.env,
            options.siteId,
            timeWindow(request.time),
            filters,
            request.includeDetails === true,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new InvalidCursorError("pages");
          return {
            value: await queryPagesWithTabsFromD1(
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
        const rawPage = request.page;
        const page =
          rawPage && typeof rawPage === "object"
            ? (rawPage as { limit?: unknown; cursor?: unknown })
            : {};
        {
          const limit =
            typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
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
          if (cursorText && !cursor) throw new InvalidCursorError("pages");
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
      }),
    )
    .register(
      "referrers",
      typedQueryProviderFor("referrers", async (input) => {
        const request = input;
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
            : {};
        {
          const limit =
            typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
          const cursorText =
            typeof page.cursor === "string" ? page.cursor : null;
          const sortBy =
            stringField(request, "sort") === "visitors" ? "visitors" : "views";
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
          if (cursorText && !cursor) throw new InvalidCursorError("referrers");
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
      }),
    )
    .register(
      "pages-dashboard",
      typedQueryProviderFor("pages-dashboard", async (input) => {
        const request = input;
        return {
          value: await queryPagesDashboard(options.env, options.siteId, {
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            interval: request.interval,
            search: request.search,
            sort: request.sort,
            comparison: request.comparison,
            page: request.page ?? { limit: 12, cursor: null },
            audience: request.context.policy.audience,
          }),
        };
      }),
    );
}
