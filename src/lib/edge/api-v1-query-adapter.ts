import type {
  BrowserCrossBreakdownDimensionDataRow,
  Interval,
  JourneyEventRow,
} from "./query/core";
import {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventRecord,
  mapEventSummaryCards,
  mapTabs,
  mapVisitors,
  parseEventFieldPath,
  parseEventFieldValueType,
  parseEventName,
  parseEventRecordSort,
  parseFilterOptionKey,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseSessionListSort,
  parseVisitorListSort,
} from "./query/core";
import { resolveCrossBreakdownDimension } from "./query/core-dimensions";
import {
  queryDimensionFromD1,
  querySessionBoundaryDimensionFromD1,
} from "./query/dimensions";
import { queryEventAnalyticsContextCardsFromD1 } from "./query/events-context";
import { queryEventFieldValuesFromD1 } from "./query/events-fields";
import { queryEventFieldsFromD1 } from "./query/events-fields";
import { queryEventTypeOverviewFromD1 } from "./query/events-overview";
import {
  parseEventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "./query/events-records";
import {
  queryEventsSummaryFromD1,
  queryEventTypeAggregate,
} from "./query/events-summary";
import { queryEventsTrendFromD1 } from "./query/events-trend";
import { queryEventTypeTrendFromD1 } from "./query/events-trend";
import { queryFilterValuesFromD1 } from "./query/filter-values";
import {
  type FunnelAnalysis,
  type FunnelStepConfig,
  queryFunnelAnalysis,
} from "./query/funnels";
import {
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "./query/journey-detail-queries";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  queryJourneyEventsFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "./query/journey-list-queries";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "./query/journey-retention";
import {
  createOverviewReader,
  toQueryTime,
} from "./query/overview-contract-adapter";
import type { TeamDashboardQueryResult } from "./query/team";
import { queryCrossDimensionFromD1 } from "./query/technology/client-cross";
import { readTeamDashboard } from "./query-runtime/team-dashboard";
import type { ParsedTimeRange } from "./api-v1-helpers";
import type { CursorPagination } from "./api-v1-helpers";
import {
  type AnalyticsResult,
  executeOverview,
  executeQueryOperation,
  executeTrend,
  type FilterValueOption,
  type OverviewResult,
  parseApiV1FilterUrl,
  siteQueryContext,
  teamQueryContext,
  type TrendResult,
} from "./query-contract";
import type { Env } from "./types";

function queryTime(timeRange: ParsedTimeRange) {
  return toQueryTime({
    startMs: timeRange.startMs,
    endExclusiveMs: timeRange.endExclusiveMs,
    nowMs: Date.now(),
    timeZone: timeRange.timeZone,
  });
}

function apiV1FilterSet(url: URL) {
  return parseApiV1FilterUrl(url);
}

/**
 * API v1 protocol adapter. It owns v1's URL-derived filters and time parsing,
 * then invokes the typed query service without an internal HTTP response hop.
 */
export function queryApiV1Overview(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<OverviewResult>> {
  return executeOverview(createOverviewReader(env, siteId), {
    context: siteQueryContext(siteId, "api-v1"),
    time: queryTime(timeRange),
    filters: apiV1FilterSet(url),
  });
}

export function queryApiV1Trend(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  interval: TrendResult["interval"],
): Promise<AnalyticsResult<TrendResult>> {
  return executeTrend(createOverviewReader(env, siteId), {
    context: siteQueryContext(siteId, "api-v1"),
    time: queryTime(timeRange),
    filters: apiV1FilterSet(url),
    interval,
  });
}

export function apiV1OverviewMetrics(result: OverviewResult) {
  const metrics = result.current;
  return {
    views: metrics.views,
    sessions: metrics.sessions,
    visitors: metrics.visitors,
    bounces: metrics.bounces,
    totalDurationMs: metrics.totalDurationMs,
    avgDurationMs:
      metrics.sessions > 0
        ? Math.round(metrics.totalDurationMs / metrics.sessions)
        : 0,
    bounceRate: metrics.sessions > 0 ? metrics.bounces / metrics.sessions : 0,
    approximateVisitors: false,
  };
}

export function queryApiV1TeamDashboard(
  env: Env,
  teamId: string,
  authorizedSiteIds: readonly string[] | undefined,
  timeRange: ParsedTimeRange,
  interval: Interval,
): Promise<AnalyticsResult<TeamDashboardQueryResult["data"]>> {
  return executeQueryOperation(
    "team-dashboard",
    {
      context: teamQueryContext(teamId, "api-v1", authorizedSiteIds),
      time: queryTime(timeRange),
    },
    async () => {
      const result = await readTeamDashboard({
        env,
        teamId,
        window: {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        interval,
        allowedSiteIds: authorizedSiteIds,
      });
      return { value: result.data, source: result.source };
    },
  );
}

interface ApiV1KeysetResult<T extends object> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

function apiV1QueryBase(url: URL, timeRange: ParsedTimeRange) {
  return {
    context: siteQueryContext("", "api-v1"),
    time: queryTime(timeRange),
    filters: apiV1FilterSet(url),
  };
}

function invalidCursorResult<T>(kind: string): AnalyticsResult<T> {
  return { ok: false, error: { kind: "invalid-cursor", cursorKind: kind } };
}

/**
 * API v1 keeps a few response-specific readers in api-v1.ts. These named
 * entry points ensure they can only run after the typed operation gate has
 * accepted the normalized API v1 context.
 */
export function queryApiV1Performance<T>(
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  reader: () => Promise<T>,
): Promise<AnalyticsResult<T>> {
  return executeQueryOperation(
    "performance",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({ value: await reader() }),
  );
}

export function queryApiV1Explore<T>(
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  reader: () => Promise<T>,
): Promise<AnalyticsResult<T>> {
  return executeQueryOperation(
    "explore",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({ value: await reader() }),
  );
}

export function queryApiV1TeamBreakdown<T>(
  teamId: string,
  authorizedSiteIds: readonly string[],
  url: URL,
  timeRange: ParsedTimeRange,
  reader: () => Promise<T>,
): Promise<AnalyticsResult<T>> {
  return executeQueryOperation(
    "explore",
    {
      ...apiV1QueryBase(url, timeRange),
      context: teamQueryContext(teamId, "api-v1", authorizedSiteIds),
    },
    async () => ({ value: await reader() }),
  );
}

export function queryApiV1FunnelAnalysis(
  env: Env,
  siteId: string,
  timeRange: ParsedTimeRange,
  steps: FunnelStepConfig[],
): Promise<AnalyticsResult<FunnelAnalysis>> {
  return executeQueryOperation(
    "funnel-analysis",
    {
      ...apiV1QueryBase(new URL("https://internal.invalid"), timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await queryFunnelAnalysis(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(new URL("https://internal.invalid")),
        steps,
      ),
    }),
  );
}

export function queryApiV1SavedFunnelAnalysis<Funnel extends object>(
  env: Env,
  siteId: string,
  timeRange: ParsedTimeRange,
  load: () => Promise<{
    readonly funnel: Funnel | null;
    readonly steps: FunnelStepConfig[];
  }>,
): Promise<
  AnalyticsResult<{
    readonly funnel: Funnel | null;
    readonly analysis: FunnelAnalysis | null;
  }>
> {
  return executeQueryOperation(
    "funnel-analysis",
    {
      ...apiV1QueryBase(new URL("https://internal.invalid"), timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const loaded = await load();
      return {
        value: {
          funnel: loaded.funnel,
          analysis:
            loaded.funnel && loaded.steps.length >= 2
              ? await queryFunnelAnalysis(
                  env,
                  siteId,
                  {
                    startMs: timeRange.startMs,
                    endExclusiveMs: timeRange.endExclusiveMs,
                    nowMs: Date.now(),
                    timeZone: timeRange.timeZone,
                  },
                  apiV1FilterSet(new URL("https://internal.invalid")),
                  loaded.steps,
                )
              : null,
        },
      };
    },
  );
}

export async function queryApiV1EventRecords(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  pagination: CursorPagination,
): Promise<AnalyticsResult<ApiV1KeysetResult<Record<string, unknown>>>> {
  const sort = parseEventRecordSort(url);
  const cursor = pagination.cursor
    ? parseEventRecordCursor(pagination.cursor, sort)
    : null;
  if (pagination.cursor && !cursor) return invalidCursorResult("event-record");
  const base = apiV1QueryBase(url, timeRange);
  return executeQueryOperation(
    "event-records",
    {
      ...base,
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const page = await queryEventRecordPageFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
        {
          pageSize: pagination.limit,
          sort,
          search: parseListSearch(url),
          eventName: url.searchParams.get("eventName")?.trim() || undefined,
          cursor,
        },
      );
      return {
        value: {
          data: page.rows.map(mapEventRecord),
          pagination: {
            limit: pagination.limit,
            nextCursor: page.nextCursor
              ? serializeEventRecordCursor(page.nextCursor)
              : null,
            hasMore: page.nextCursor !== null,
          },
        },
      };
    },
  );
}

export async function queryApiV1EventTypes(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<readonly Record<string, unknown>[]>> {
  return executeQueryOperation(
    "event-types",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: mapTabs(
        await queryEventTypeAggregate(
          env,
          siteId,
          {
            startMs: timeRange.startMs,
            endExclusiveMs: timeRange.endExclusiveMs,
            nowMs: Date.now(),
            timeZone: timeRange.timeZone,
          },
          apiV1FilterSet(url),
          parseLimit(url, 20, 200),
        ),
      ),
    }),
  );
}

export async function queryApiV1EventFieldValues(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<readonly Record<string, unknown>[]>> {
  const eventName = parseEventName(url);
  const fieldPath = parseEventFieldPath(url);
  const fieldValueType = parseEventFieldValueType(url);
  if (!eventName || !fieldPath || !fieldValueType) {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "event fields", code: "missing_required_value" }],
      },
    };
  }
  return executeQueryOperation(
    "event-field-values",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: (
        await queryEventFieldValuesFromD1(
          env,
          siteId,
          {
            startMs: timeRange.startMs,
            endExclusiveMs: timeRange.endExclusiveMs,
            nowMs: Date.now(),
            timeZone: timeRange.timeZone,
          },
          apiV1FilterSet(url),
          eventName,
          fieldPath,
          fieldValueType,
          parseLimit(url, 25, 100),
          parseListSearch(url),
        )
      ).map(mapEventFieldValue),
    }),
  );
}

export async function queryApiV1EventFields(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<Record<string, unknown>>> {
  const eventName = parseEventName(url);
  if (!eventName) {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "eventName", code: "missing_required_value" }],
      },
    };
  }
  return executeQueryOperation(
    "event-fields",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: {
        eventName,
        fields: (
          await queryEventFieldsFromD1(
            env,
            siteId,
            {
              startMs: timeRange.startMs,
              endExclusiveMs: timeRange.endExclusiveMs,
              nowMs: Date.now(),
              timeZone: timeRange.timeZone,
            },
            apiV1FilterSet(url),
            eventName,
            parseLimit(url, 100, 200),
          )
        ).map(mapEventField),
      },
    }),
  );
}

export async function queryApiV1FilterValues(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<
  AnalyticsResult<{ field: string; data: readonly FilterValueOption[] }>
> {
  const field = parseFilterOptionKey(url);
  if (!field) {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "field", code: "unsupported_filter_field" }],
      },
    };
  }
  return executeQueryOperation(
    "filter-values",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
      filters: apiV1FilterSet(url),
    },
    async () => ({
      value: {
        field,
        data: (
          await queryFilterValuesFromD1(
            env,
            siteId,
            {
              startMs: timeRange.startMs,
              endExclusiveMs: timeRange.endExclusiveMs,
              nowMs: Date.now(),
              timeZone: timeRange.timeZone,
            },
            apiV1FilterSet(url),
            field,
            parseLimit(url, 50, 500),
            parseListSearch(url),
          )
        ).map((row) => ({
          value: row.value,
          label: row.value,
          occurrences: row.occurrences,
        })),
      },
    }),
  );
}

export async function queryApiV1EventsSummary(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<Record<string, unknown>>> {
  return executeQueryOperation(
    "event-summary",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const data = await queryEventsSummaryFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
      );
      return {
        value: {
          summary: {
            events: Number(data.summary.events ?? 0),
            eventTypes: Number(data.summary.eventTypes ?? 0),
            sessions: Number(data.summary.sessions ?? 0),
            visitors: Number(data.summary.visitors ?? 0),
            avgEventsPerSession:
              Number(data.summary.sessions ?? 0) > 0
                ? Number(data.summary.events ?? 0) /
                  Number(data.summary.sessions ?? 0)
                : 0,
          },
          cards: mapEventSummaryCards(data.cards),
        },
      };
    },
  );
}

export async function queryApiV1EventsTrend(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<Record<string, unknown>>> {
  const interval = parseInterval(url);
  return executeQueryOperation(
    "event-trend",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: {
        interval,
        ...(await queryEventsTrendFromD1(
          env,
          siteId,
          {
            startMs: timeRange.startMs,
            endExclusiveMs: timeRange.endExclusiveMs,
            nowMs: Date.now(),
            timeZone: timeRange.timeZone,
          },
          interval,
          apiV1FilterSet(url),
          parseLimit(url, 8, 12),
          parseEventName(url),
        )),
      },
    }),
  );
}

export async function queryApiV1Retention(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<RetentionResult>> {
  const granularity = parseRetentionGranularity(
    url.searchParams.get("granularity") ?? url.searchParams.get("interval"),
  );
  return executeQueryOperation(
    "retention",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await queryRetentionFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
        granularity,
      ),
    }),
  );
}

export async function queryApiV1CrossBreakdown(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  primary: string,
  secondary: string,
): Promise<AnalyticsResult<BrowserCrossBreakdownDimensionDataRow>> {
  const primaryDimension = resolveCrossBreakdownDimension(primary);
  const secondaryDimension = resolveCrossBreakdownDimension(secondary);
  if (!primaryDimension || !secondaryDimension || primary === secondary) {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "dimensions", code: "unsupported_cross_dimension" }],
      },
    };
  }
  return executeQueryOperation(
    "cross-dimension",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await queryCrossDimensionFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
        parseQueryLimit(url, "primaryLimit", 5, 1, 12),
        parseQueryLimit(url, "secondaryLimit", 6, 1, 8),
        primaryDimension,
        secondaryDimension,
      ),
    }),
  );
}

export async function queryApiV1Breakdown(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  dimension: string,
): Promise<AnalyticsResult<readonly Record<string, unknown>[]>> {
  const window = {
    startMs: timeRange.startMs,
    endExclusiveMs: timeRange.endExclusiveMs,
    nowMs: Date.now(),
    timeZone: timeRange.timeZone,
  };
  return executeQueryOperation(
    "dimension",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const limit = parseLimit(url, 20, 200);
      const filters = apiV1FilterSet(url);
      const rows =
        dimension === "session.entryPath"
          ? await querySessionBoundaryDimensionFromD1(
              env,
              siteId,
              window,
              filters,
              limit,
              "entry",
            )
          : dimension === "session.exitPath"
            ? await querySessionBoundaryDimensionFromD1(
                env,
                siteId,
                window,
                filters,
                limit,
                "exit",
              )
            : dimension === "event.name"
              ? await queryEventTypeAggregate(
                  env,
                  siteId,
                  window,
                  filters,
                  limit,
                )
              : await queryDimensionFromD1(
                  env,
                  siteId,
                  window,
                  filters,
                  limit,
                  resolveCrossBreakdownDimension(dimension)?.labelExpr ?? "''",
                  { excludeEmpty: true },
                );
      return {
        value: rows.map((row) => ({
          value: row.value,
          label: row.value,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        })),
      };
    },
  );
}

export async function queryApiV1EventRecordDetail(
  env: Env,
  siteId: string,
  eventId: string,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<unknown>> {
  return executeQueryOperation(
    "event-record-detail",
    {
      ...apiV1QueryBase(new URL("https://internal.invalid"), timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await queryEventRecordDetailFromD1(env, siteId, eventId),
    }),
  );
}

export async function queryApiV1EventTypeDetail(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  eventName: string,
): Promise<AnalyticsResult<Record<string, unknown>>> {
  const interval = parseInterval(url);
  return executeQueryOperation(
    "event-type-detail",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const window = {
        startMs: timeRange.startMs,
        endExclusiveMs: timeRange.endExclusiveMs,
        nowMs: Date.now(),
        timeZone: timeRange.timeZone,
      };
      const filters = apiV1FilterSet(url);
      const [overview, trend, fields, cards] = await Promise.all([
        queryEventTypeOverviewFromD1(env, siteId, window, filters, eventName, {
          includeBreakdowns: true,
        }),
        queryEventTypeTrendFromD1(
          env,
          siteId,
          window,
          interval,
          filters,
          eventName,
        ),
        queryEventFieldsFromD1(env, siteId, window, filters, eventName, 100),
        queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          filters,
          100,
          eventName,
        ),
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
          cards: mapEventAnalyticsContextCards(cards),
          fields: fields.map(mapEventField),
        },
      };
    },
  );
}

export async function queryApiV1Visitors(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  pagination: CursorPagination,
): Promise<AnalyticsResult<ApiV1KeysetResult<Record<string, unknown>>>> {
  const sort = parseVisitorListSort(url);
  const cursor = pagination.cursor
    ? parseVisitorListCursor(pagination.cursor, sort)
    : null;
  if (pagination.cursor && !cursor) return invalidCursorResult("visitor-list");
  return executeQueryOperation(
    "visitors",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const page = await queryVisitorListPageFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
        {
          pageSize: pagination.limit,
          sort,
          search: parseListSearch(url),
          cursor,
        },
      );
      return {
        value: {
          data: mapVisitors(page.rows),
          pagination: {
            limit: pagination.limit,
            nextCursor: page.nextCursor
              ? serializeVisitorListCursor(page.nextCursor)
              : null,
            hasMore: page.nextCursor !== null,
          },
        },
      };
    },
  );
}

export async function queryApiV1Sessions(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  pagination: CursorPagination,
): Promise<AnalyticsResult<ApiV1KeysetResult<Record<string, unknown>>>> {
  const sort = parseSessionListSort(url);
  const cursor = pagination.cursor
    ? parseSessionListCursor(pagination.cursor, sort)
    : null;
  if (pagination.cursor && !cursor) return invalidCursorResult("session-list");
  return executeQueryOperation(
    "sessions",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => {
      const page = await querySessionListPageFromD1(
        env,
        siteId,
        {
          startMs: timeRange.startMs,
          endExclusiveMs: timeRange.endExclusiveMs,
          nowMs: Date.now(),
          timeZone: timeRange.timeZone,
        },
        apiV1FilterSet(url),
        {
          pageSize: pagination.limit,
          sort,
          search: parseListSearch(url),
          cursor,
        },
      );
      return {
        value: {
          data: page.rows as unknown as readonly Record<string, unknown>[],
          pagination: {
            limit: pagination.limit,
            nextCursor: page.nextCursor
              ? serializeSessionListCursor(page.nextCursor)
              : null,
            hasMore: page.nextCursor !== null,
          },
        },
      };
    },
  );
}

export async function queryApiV1VisitorDetail(
  env: Env,
  siteId: string,
  visitorId: string,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<unknown>> {
  return executeQueryOperation(
    "visitor-detail",
    {
      ...apiV1QueryBase(new URL("https://internal.invalid"), timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await queryVisitorDetailFromD1(
        env,
        siteId,
        visitorId,
        timeRange.timeZone,
      ),
    }),
  );
}

export async function queryApiV1SessionDetail(
  env: Env,
  siteId: string,
  sessionId: string,
  timeRange: ParsedTimeRange,
): Promise<AnalyticsResult<unknown>> {
  return executeQueryOperation(
    "session-detail",
    {
      ...apiV1QueryBase(new URL("https://internal.invalid"), timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: await querySessionDetailFromD1(env, siteId, sessionId),
    }),
  );
}

export async function queryApiV1JourneyEvents(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  pagination: CursorPagination,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): Promise<AnalyticsResult<ApiV1KeysetResult<JourneyEventRow>>> {
  if (pagination.cursor) return invalidCursorResult("journey-events");
  return executeQueryOperation(
    "event-records",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: {
        data: await queryJourneyEventsFromD1(
          env,
          siteId,
          {
            startMs: timeRange.startMs,
            endExclusiveMs: timeRange.endExclusiveMs,
            nowMs: Date.now(),
            timeZone: timeRange.timeZone,
          },
          apiV1FilterSet(url),
          target,
          pagination.limit,
        ),
        pagination: {
          limit: pagination.limit,
          nextCursor: null,
          hasMore: false,
        },
      },
    }),
  );
}

export async function queryApiV1JourneySessions(
  env: Env,
  siteId: string,
  url: URL,
  timeRange: ParsedTimeRange,
  pagination: CursorPagination,
  target: { readonly type: "visitor" | "session"; readonly value: string },
): Promise<AnalyticsResult<ApiV1KeysetResult<Record<string, unknown>>>> {
  if (pagination.cursor) return invalidCursorResult("journey-sessions");
  return executeQueryOperation(
    "sessions",
    {
      ...apiV1QueryBase(url, timeRange),
      context: siteQueryContext(siteId, "api-v1"),
    },
    async () => ({
      value: {
        data: (await querySessionsFromD1(
          env,
          siteId,
          {
            startMs: timeRange.startMs,
            endExclusiveMs: timeRange.endExclusiveMs,
            nowMs: Date.now(),
            timeZone: timeRange.timeZone,
          },
          apiV1FilterSet(url),
          pagination.limit,
          target,
        )) as unknown as readonly Record<string, unknown>[],
        pagination: {
          limit: pagination.limit,
          nextCursor: null,
          hasMore: false,
        },
      },
    }),
  );
}
