import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import type {
  FilterValuesResult,
  OverviewQuery,
  OverviewReader,
  OverviewResult,
  PageItem,
  PagesResult,
  QueryInput,
  QueryTime,
  ReferrerItem,
  ReferrersResult,
  TrendQuery,
  TrendResult,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { queryChannelAggregate } from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  geoTabLabel,
  mapDimensionRows,
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventRecord,
  mapEventSummaryCards,
  mapGeoTabs,
  mapTabs,
  mapVisitors,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  regionValueExpr,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { querySessionBoundaryDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  EVENT_CONTEXT_CARD_KEYS,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  queryEventsSummaryFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryFilterValuesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import {
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitions,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import {
  queryGeoPointAggregate,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import { queryDimensionAggregate } from "@/lib/edge/analytics/providers/d1/internal/pages";
import {
  queryPagesAggregate,
  queryPagesDashboard,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import {
  queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import {
  queryClientDimensionTrendFromD1,
  queryReferrerAndChannelTrendFromD1,
  queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

export interface D1SiteQueryRuntimeOptions {
  readonly env: Env;
  readonly siteId: string;
  readonly diagnostics?: D1ReadDiagnostics;
}

type RuntimeQuery = QueryInput & {
  readonly time: QueryTime;
  readonly [key: string]: unknown;
};

function query(input: QueryInput): RuntimeQuery {
  return input as RuntimeQuery;
}

function stringField(input: RuntimeQuery, name: string, fallback = ""): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

function numberField(
  input: RuntimeQuery,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timeWindow(time: QueryTime) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function measured<T>(operation: string, action: () => Promise<T>): Promise<T> {
  const logger = currentInvocationLogger();
  return logger
    ? logger.measure(operation, () => runWithD1Operation(operation, action))
    : action();
}

function arrayField(input: RuntimeQuery, name: string): readonly unknown[] {
  return Array.isArray(input[name]) ? input[name] : [];
}

function emptyEventContextCards() {
  return {
    page: { path: [], query: [], title: [], hostname: [], entry: [], exit: [] },
    source: { domain: [], link: [] },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

function dimensionExpression(dimension: string): string {
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

function overviewProvider(reader: OverviewReader) {
  return typedQueryProvider<OverviewResult>(async (input) => {
    const query = input as OverviewQuery;
    const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
    const current = await reader.readOverview({
      time: query.time,
      filters,
    });
    const previous = query.previousTime
      ? await reader.readOverview({
          time: query.previousTime,
          filters,
        })
      : undefined;
    const detailInterval = query.detailInterval;
    const detail = detailInterval
      ? await reader.readTrend({
          time: query.time,
          filters,
          interval: detailInterval,
        })
      : undefined;
    const detailResult =
      detail && detailInterval
        ? { interval: detailInterval, points: detail.value }
        : undefined;

    return {
      value: {
        current: current.value,
        ...(previous ? { previous: previous.value } : {}),
        ...(detailResult ? { detail: detailResult } : {}),
      },
      source:
        previous && previous.source !== current.source
          ? "mixed"
          : current.source,
      approximateVisitors:
        current.approximateVisitors || Boolean(previous?.approximateVisitors),
    };
  });
}

function trendProvider(reader: OverviewReader) {
  return typedQueryProvider<TrendResult>(async (input) => {
    const query = input as TrendQuery;
    const result = await reader.readTrend({
      time: query.time,
      filters: query.filters ?? EMPTY_FILTER_DOCUMENT,
      interval: query.interval,
    });
    return {
      value: {
        interval: query.interval,
        points: result.value,
      },
      source: result.source,
      approximateVisitors: result.approximateVisitors,
    };
  });
}

async function overviewTabData(
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

function registerEventProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "event-types",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: mapTabs(
            await queryEventTypeAggregate(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              numberField(request, "limit", 20),
              stringField(request, "search") || undefined,
            ),
          ),
        };
      }),
    )
    .register(
      "event-summary",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const data = await queryEventsSummaryFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
        );
        const events = Number(data.summary.events ?? 0);
        const sessions = Number(data.summary.sessions ?? 0);
        return {
          value: {
            summary: {
              events,
              eventTypes: Number(data.summary.eventTypes ?? 0),
              sessions,
              visitors: Number(data.summary.visitors ?? 0),
              avgEventsPerSession: sessions > 0 ? events / sessions : 0,
            },
            cards: mapEventSummaryCards(data.cards),
          },
        };
      }),
    )
    .register(
      "event-trend",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const interval = request.interval as never;
        return {
          value: {
            interval,
            ...(await queryEventsTrendFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              interval,
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              numberField(request, "limit", 8),
              stringField(request, "eventName") || undefined,
            )),
          },
        };
      }),
    )
    .register(
      "event-records",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page = await queryEventRecordPageFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          {
            pageSize: numberField(request, "pageSize", 80),
            sort: request.sort as never,
            search: stringField(request, "search") || undefined,
            eventName: stringField(request, "eventName") || undefined,
            cursor: (request.cursor as never) ?? null,
          },
        );
        return {
          value: {
            data: page.rows.map(mapEventRecord),
            meta: {
              pageSize: numberField(request, "pageSize", 80),
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeEventRecordCursor(page.nextCursor)
                : null,
            },
          },
        };
      }),
    )
    .register(
      "event-field-values",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        const fieldPath = stringField(request, "fieldPath");
        const fieldValueType = stringField(request, "fieldValueType");
        return {
          value: {
            fieldPath,
            fieldValueType,
            data: (
              await queryEventFieldValuesFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                eventName,
                fieldPath,
                fieldValueType,
                numberField(request, "limit", 25),
                stringField(request, "search") || undefined,
              )
            ).map(mapEventFieldValue),
          },
        };
      }),
    )
    .register(
      "event-fields",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        return {
          value: {
            eventName,
            fields: (
              await measured("event_type_fields", () =>
                queryEventFieldsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  eventName,
                  numberField(request, "limit", 100),
                ),
              )
            ).map(mapEventField),
          },
        };
      }),
    )
    .register(
      "event-context",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        const selectedKeys = arrayField(request, "selectedKeys").filter(
          (key): key is (typeof EVENT_CONTEXT_CARD_KEYS)[number] =>
            typeof key === "string" &&
            EVENT_CONTEXT_CARD_KEYS.includes(
              key as (typeof EVENT_CONTEXT_CARD_KEYS)[number],
            ),
        );
        return {
          value: {
            eventName,
            cards: mapEventAnalyticsContextCards(
              await measured("event_type_context", () =>
                queryEventAnalyticsContextCardsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  numberField(request, "limit", 100),
                  eventName,
                  selectedKeys.length > 0 ? selectedKeys : undefined,
                ),
              ),
            ),
          },
        };
      }),
    )
    .register(
      "event-type-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        const includeContext = request.includeContext !== false;
        const includeBreakdowns = request.includeBreakdowns !== false;
        const includeFields = request.includeFields !== false;
        const [overview, trend, fields, cards] = await Promise.all([
          measured("event_type_detail.overview", () =>
            queryEventTypeOverviewFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              eventName,
              { includeBreakdowns },
            ),
          ),
          measured("event_type_detail.trend", () =>
            queryEventTypeTrendFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.interval as never,
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              eventName,
            ),
          ),
          includeFields
            ? measured("event_type_detail.fields", () =>
                queryEventFieldsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  eventName,
                  100,
                ),
              )
            : Promise.resolve([]),
          includeContext
            ? measured("event_type_detail.context_cards", () =>
                queryEventAnalyticsContextCardsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  100,
                  eventName,
                ),
              )
            : Promise.resolve(null),
        ]);
        return {
          value: {
            eventName,
            summary: overview.summary,
            trend,
            breakdowns: {
              pages: mapTabs(overview.breakdowns.pages),
              countries: mapTabs(overview.breakdowns.countries),
              devices: mapTabs(overview.breakdowns.devices),
              browsers: mapTabs(overview.breakdowns.browsers),
            },
            cards: cards
              ? mapEventAnalyticsContextCards(cards)
              : emptyEventContextCards(),
            fields: fields.map(mapEventField),
          },
        };
      }),
    )
    .register(
      "event-record-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryEventRecordDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "eventId"),
            timeWindow(request.time),
          ),
        };
      }),
    );
}

function registerJourneyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "visitors",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const pageSize = numberField(request, "pageSize", 80);
        const page = request.paged
          ? await queryVisitorListPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              {
                pageSize,
                sort: request.sort as never,
                search: stringField(request, "search") || undefined,
                cursor: (request.cursor as never) ?? null,
              },
            )
          : {
              rows: await queryVisitorsFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                pageSize,
                undefined,
                0,
                request.sort as never,
                stringField(request, "search") || undefined,
              ),
              nextCursor: null,
            };
        return {
          value: {
            data: mapVisitors(page.rows),
            meta: {
              pageSize,
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeVisitorListCursor(page.nextCursor)
                : null,
            },
          },
        };
      }),
    )
    .register(
      "sessions",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const pageSize = numberField(request, "pageSize", 80);
        const page = request.paged
          ? await querySessionListPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              {
                pageSize,
                sort: request.sort as never,
                search: stringField(request, "search") || undefined,
                cursor: (request.cursor as never) ?? null,
              },
            )
          : {
              rows: await querySessionsFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                pageSize,
                undefined,
                0,
                request.sort as never,
                stringField(request, "search") || undefined,
              ),
              nextCursor: null,
            };
        return {
          value: {
            data: page.rows,
            meta: {
              pageSize,
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeSessionListCursor(page.nextCursor)
                : null,
            },
          },
        };
      }),
    )
    .register(
      "visitor-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryVisitorDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "visitorId"),
            stringField(request, "timeZone", "UTC"),
          ),
        };
      }),
    )
    .register(
      "session-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await querySessionDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "sessionId"),
          ),
        };
      }),
    );
}

function registerTechnologyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "share-trend",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const interval = request.interval as never;
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const limit = numberField(request, "limit", 5);
        const variant = stringField(request, "variant", "browser");
        const value =
          variant === "browser"
            ? await queryBrowserTrendFromD1(
                options.env,
                options.siteId,
                window,
                interval,
                filters,
                limit,
              )
            : variant === "browser-engine"
              ? await queryBrowserEngineTrendFromD1(
                  options.env,
                  options.siteId,
                  window,
                  interval,
                  filters,
                  limit,
                )
              : variant === "client"
                ? await queryClientDimensionTrendFromD1(
                    options.env,
                    options.siteId,
                    window,
                    interval,
                    filters,
                    stringField(request, "dimension") as never,
                    limit,
                  )
                : variant === "utm"
                  ? await queryUtmDimensionTrendFromD1(
                      options.env,
                      options.siteId,
                      window,
                      interval,
                      filters,
                      stringField(request, "dimension") as never,
                      limit,
                    )
                  : variant === "referrer-channel"
                    ? await queryReferrerAndChannelTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        filters,
                        limit,
                      )
                    : await queryReferrerTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        filters,
                        limit,
                      );
        return { value };
      }),
    )
    .register(
      "radar",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const variant = stringField(request, "variant", "browser");
        const value =
          variant === "version"
            ? await queryBrowserVersionBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "browserLimit", 0),
                numberField(request, "versionLimit", 5),
              )
            : variant === "referrer"
              ? await queryReferrerRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                  numberField(request, "limit", 24),
                )
              : await queryBrowserRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                );
        return { value };
      }),
    )
    .register(
      "cross-dimension",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const value =
          stringField(request, "variant") === "browser"
            ? await queryBrowserCrossBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "browserLimit", 8),
                numberField(request, "osLimit", 6),
                numberField(request, "deviceTypeLimit", 5),
              )
            : await queryCrossDimensionFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "primaryLimit", 5),
                numberField(request, "secondaryLimit", 6),
                request.primaryDimension as never,
                request.secondaryDimension as never,
              );
        return { value };
      }),
    );
}

function registerFunnelProvider(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry.register(
    "funnel-analysis",
    typedQueryProvider<Record<string, unknown>>(async (input) => {
      const request = query(input!);
      const funnelId = stringField(request, "funnelId");
      if (!funnelId) {
        return {
          value: {
            funnels: await queryFunnelDefinitions(options.env, options.siteId),
          } as Record<string, unknown>,
        };
      }
      const funnel = await queryFunnelDefinition(
        options.env,
        options.siteId,
        funnelId,
      );
      return {
        value: {
          funnel,
          analysis:
            funnel && funnel.steps.length >= 2
              ? await queryFunnelAnalysis(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  funnel.steps,
                )
              : null,
        } as Record<string, unknown>,
      };
    }),
  );
}

function registerSiteContractProviders(
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

/**
 * Compose the D1 implementation for the canonical site overview operations.
 * Audience policy and filter authorization are validated by the application
 * service before the provider is invoked.
 */
export function createD1SiteQueryRuntime(options: D1SiteQueryRuntimeOptions) {
  const diagnostics = options.diagnostics ?? createD1ReadDiagnostics();
  const reader = createOverviewReader(options.env, options.siteId, diagnostics);
  const registry = new AnalyticsProviderRegistry()
    .register("overview", overviewProvider(reader))
    .register("trend", trendProvider(reader));
  registerSiteContractProviders(registry, options);
  registerEventProviders(registry, options);
  registerJourneyProviders(registry, options);
  registerTechnologyProviders(registry, options);
  registerFunnelProvider(registry, options);

  return createAnalyticsQueryRuntime(registry);
}

export type { D1ReadDiagnostics };
