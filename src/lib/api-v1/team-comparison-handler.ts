import {
  type TeamComparisonBreakdownQueryDto,
  TeamComparisonBreakdownQueryDtoSchema,
  TeamComparisonOverviewQueryDtoSchema,
  TeamComparisonTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1ComparisonDatasetTimeRange } from "@/lib/api-v1/time-range";
import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/catalog";
import {
  AnalyticsQueryService,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import {
  type BreakdownItem,
  type BreakdownResult,
  type FilterDocument,
  type OverviewMetrics,
  parseApiV1FilterDocument,
  teamQueryContext,
  type TrendResult,
} from "@/lib/edge/query-contract";
import type { TeamOverviewQueryResult } from "@/lib/edge/query-runtime/team-overview";
import type { TeamTimeseriesQueryResult } from "@/lib/edge/query-runtime/team-timeseries";

const MAX_BODY_BYTES = 64 * 1024;
const DIMENSIONS = new Set<string>(ANALYTICS_DIMENSIONS);

interface TeamComparisonReaderInput {
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type TeamComparisonOverviewReader = (
  input: TeamComparisonReaderInput,
) => Promise<TeamOverviewQueryResult>;
export type TeamComparisonTimeseriesReader = (
  input: TeamComparisonReaderInput & {
    readonly interval: TrendResult["interval"];
  },
) => Promise<TeamTimeseriesQueryResult>;
export type TeamComparisonBreakdownReader = (
  input: TeamComparisonReaderInput & {
    readonly dimension: string;
    readonly limit: number;
  },
) => Promise<BreakdownResult>;

function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(code: keyof typeof apiV1ErrorRegistry): Response {
  const requestId = crypto.randomUUID();
  const error = apiV1ErrorRegistry[code];
  return response(
    error.status,
    {
      error: { code, message: error.message, retryable: error.retryable },
      meta: { requestId },
    },
    requestId,
  );
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return (
    !accept ||
    accept.split(",").some((part) => {
      const value = part.split(";", 1)[0]?.trim().toLowerCase();
      return (
        value === "application/json" ||
        value === "application/*" ||
        value === "*/*"
      );
    })
  );
}

function filter(value: {
  readonly filter?: { readonly expression: unknown } | null;
}): FilterDocument | null {
  if (!value.filter) return { version: 1, root: null };
  try {
    return parseApiV1FilterDocument({
      version: 1,
      root: value.filter.expression,
    });
  } catch {
    return null;
  }
}

function comparisonFilters(value: {
  readonly a: { readonly filter?: { readonly expression: unknown } | null };
  readonly b: { readonly filter?: { readonly expression: unknown } | null };
}): { readonly a: FilterDocument; readonly b: FilterDocument } | null {
  const a = filter(value.a);
  const b = filter(value.b);
  return a && b ? { a, b } : null;
}

function mapError(kind: string): keyof typeof apiV1ErrorRegistry {
  if (kind === "request-cancelled") return "request_cancelled";
  if (kind === "deadline-exceeded") return "deadline_exceeded";
  if (kind === "query-cost-exceeded") return "unsupported_query";
  return "internal_error";
}

function relative(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / b;
}

function metrics(value: OverviewMetrics) {
  return {
    views: value.views,
    sessions: value.sessions,
    visitors: value.visitors,
    bounces: value.bounces,
    totalDurationMs: value.totalDurationMs,
    avgDurationMs: value.sessions
      ? Math.round(value.totalDurationMs / value.sessions)
      : 0,
    bounceRate: value.sessions ? value.bounces / value.sessions : 0,
    approximateVisitors: false,
  };
}

function metricDelta(a: OverviewMetrics, b: OverviewMetrics) {
  return {
    views: relative(a.views, b.views),
    sessions: relative(a.sessions, b.sessions),
    visitors: relative(a.visitors, b.visitors),
    bounces: relative(a.bounces, b.bounces),
    totalDurationMs: relative(a.totalDurationMs, b.totalDurationMs),
    durationViews: relative(a.durationViews, b.durationViews),
  };
}

function point(value: TrendResult["points"][number]) {
  return {
    timestamp: new Date(value.timestampMs).toISOString(),
    views: value.views,
    sessions: value.sessions,
    visitors: value.visitors,
    bounces: value.bounces,
    totalDurationMs: value.totalDurationMs,
    avgDurationMs: value.sessions
      ? Math.round(value.totalDurationMs / value.sessions)
      : 0,
    bounceRate: value.sessions ? value.bounces / value.sessions : 0,
  };
}

function emptyItem(key: string, label: string): BreakdownItem {
  return { key, label, views: 0, sessions: 0, visitors: 0 };
}

function breakdownUnion(
  a: BreakdownResult,
  b: BreakdownResult,
  limit: number,
  sort: TeamComparisonBreakdownQueryDto["query"]["sort"],
) {
  const aItems = new Map(a.items.map((item) => [item.key, item]));
  const bItems = new Map(b.items.map((item) => [item.key, item]));
  return [...new Set([...aItems.keys(), ...bItems.keys()])]
    .map((key) => {
      const aItem = aItems.get(key);
      const bItem = bItems.get(key);
      const left = aItem ?? emptyItem(key, bItem!.label);
      const right = bItem ?? emptyItem(key, aItem!.label);
      const delta = (first: number, second: number) => ({
        absolute: first - second,
        relative: relative(first, second),
      });
      return {
        key,
        label: aItem?.label ?? bItem!.label,
        a: left,
        b: right,
        delta: {
          views: delta(left.views, right.views),
          sessions: delta(left.sessions, right.sessions),
          visitors: delta(left.visitors, right.visitors),
        },
      };
    })
    .sort((left, right) => {
      const direction = sort.direction === "desc" ? -1 : 1;
      const difference =
        (left[sort.side][sort.metric] - right[sort.side][sort.metric]) *
        direction;
      return difference || left.key.localeCompare(right.key);
    })
    .slice(0, limit);
}

async function parseComparison<T>(
  request: Request,
  principal: ApiKeyPrincipal,
  schema: { parse(input: unknown): T },
): Promise<T | Response> {
  if (request.method !== "POST") {
    const result = errorResponse("method_not_allowed");
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding"))
    return errorResponse("unsupported_media_type");
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return errorResponse("unsupported_media_type");
  if (!acceptsJson(request)) return errorResponse("not_acceptable");
  if (
    !principal.scopes.includes("analytics:read") ||
    (principal.status ?? "active") !== "active"
  )
    return errorResponse("missing_scope");
  try {
    return schema.parse(await readBoundedJson(request, MAX_BODY_BYTES));
  } catch {
    return errorResponse("validation_failed");
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function ranges(
  input: {
    readonly a: {
      readonly timeRange: Parameters<
        typeof resolveApiV1ComparisonDatasetTimeRange
      >[0];
    };
    readonly b: {
      readonly timeRange: Parameters<
        typeof resolveApiV1ComparisonDatasetTimeRange
      >[0];
    };
    readonly timeZone: string;
  },
  capturedAtMs: number,
) {
  const a = resolveApiV1ComparisonDatasetTimeRange(
    input.a.timeRange,
    input.timeZone,
    capturedAtMs,
  );
  const b = resolveApiV1ComparisonDatasetTimeRange(
    input.b.timeRange,
    input.timeZone,
    capturedAtMs,
  );
  return a && b ? { a, b } : null;
}

function meta(
  requestId: string,
  a: { from: string; to: string },
  b: { from: string; to: string },
  timeZone: string,
  source: string,
  approximate: boolean,
) {
  return {
    requestId,
    generatedAt: new Date().toISOString(),
    aTimeRange: { from: a.from, to: a.to, timeZone },
    bTimeRange: { from: b.from, to: b.to, timeZone },
    source,
    accuracy: approximate ? "approximate" : "exact",
  };
}

function sharedInput(
  principal: ApiKeyPrincipal,
  filters: FilterDocument,
  range: { from: string; to: string },
  timeZone: string,
  signal: AbortSignal | undefined,
): TeamComparisonReaderInput {
  return {
    teamId: principal.teamId,
    allowedSiteIds: principal.siteIds.length ? principal.siteIds : undefined,
    startMs: Date.parse(range.from),
    endExclusiveMs: Date.parse(range.to),
    timeZone,
    filters,
    signal,
  };
}

export async function handleTeamComparisonOverview(
  request: Request,
  principal: ApiKeyPrincipal,
  reader: TeamComparisonOverviewReader,
  context: QueryExecutionContext,
): Promise<Response> {
  const input = await parseComparison(
    request,
    principal,
    TeamComparisonOverviewQueryDtoSchema,
  );
  if (isResponse(input)) return input;
  const filters = comparisonFilters(input);
  const resolved = ranges(
    input,
    context.capturedAtMs ?? context.now?.() ?? Date.now(),
  );
  if (!filters || !resolved) return errorResponse("validation_failed");
  try {
    const query = {
      a: sharedInput(
        principal,
        filters.a,
        resolved.a,
        input.timeZone,
        undefined,
      ),
      b: sharedInput(
        principal,
        filters.b,
        resolved.b,
        input.timeZone,
        undefined,
      ),
    };
    const result = await new AnalyticsQueryService().execute(
      {
        operation: "team.analytics.comparisonOverview",
        context: teamQueryContext(
          principal.teamId,
          "api-v1",
          principal.siteIds,
        ),
        query,
        provider: {
          execute: ({ query: providerQuery, execution: providerExecution }) =>
            Promise.all([
              reader({ ...providerQuery.a, signal: providerExecution.signal }),
              reader({ ...providerQuery.b, signal: providerExecution.signal }),
            ]),
        },
      },
      {
        ...context,
        operation: "team.analytics.comparisonOverview",
        cost: {
          rangeMs:
            Date.parse(resolved.a.to) -
            Date.parse(resolved.a.from) +
            Date.parse(resolved.b.to) -
            Date.parse(resolved.b.from),
          siteCount: principal.siteIds.length || 1,
          metricCount: 6,
          dimensionCardinality: 0,
          projectionFields: 6,
          pageLimit: 1,
          provider: "d1",
          batchFanout: 2,
        },
      },
    );
    if (!result.ok) return errorResponse(mapError(result.error.kind));
    const [a, b] = result.value;
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          a: metrics(a.data),
          b: metrics(b.data),
          delta: metricDelta(a.data, b.data),
        },
        meta: meta(
          requestId,
          resolved.a,
          resolved.b,
          input.timeZone,
          a.source === b.source ? a.source : "mixed",
          a.approximateVisitors || b.approximateVisitors,
        ),
      },
      requestId,
    );
  } catch {
    return errorResponse(
      context.signal?.aborted ? "request_cancelled" : "internal_error",
    );
  }
}

export async function handleTeamComparisonTimeseries(
  request: Request,
  principal: ApiKeyPrincipal,
  reader: TeamComparisonTimeseriesReader,
  context: QueryExecutionContext,
): Promise<Response> {
  const input = await parseComparison(
    request,
    principal,
    TeamComparisonTimeseriesQueryDtoSchema,
  );
  if (isResponse(input)) return input;
  const filters = comparisonFilters(input);
  const resolved = ranges(
    input,
    context.capturedAtMs ?? context.now?.() ?? Date.now(),
  );
  if (!filters || !resolved) return errorResponse("validation_failed");
  try {
    const query = {
      a: {
        ...sharedInput(
          principal,
          filters.a,
          resolved.a,
          input.timeZone,
          undefined,
        ),
        interval: input.query.interval,
      },
      b: {
        ...sharedInput(
          principal,
          filters.b,
          resolved.b,
          input.timeZone,
          undefined,
        ),
        interval: input.query.interval,
      },
    };
    const result = await new AnalyticsQueryService().execute(
      {
        operation: "team.analytics.comparisonTimeseries",
        context: teamQueryContext(
          principal.teamId,
          "api-v1",
          principal.siteIds,
        ),
        query,
        provider: {
          execute: ({ query: providerQuery, execution: providerExecution }) =>
            Promise.all([
              reader({ ...providerQuery.a, signal: providerExecution.signal }),
              reader({ ...providerQuery.b, signal: providerExecution.signal }),
            ]),
        },
      },
      {
        ...context,
        operation: "team.analytics.comparisonTimeseries",
        cost: {
          rangeMs:
            Date.parse(resolved.a.to) -
            Date.parse(resolved.a.from) +
            Date.parse(resolved.b.to) -
            Date.parse(resolved.b.from),
          siteCount: principal.siteIds.length || 1,
          metricCount: 6,
          dimensionCardinality: 0,
          projectionFields: 6,
          pageLimit: 1,
          provider: "d1",
          batchFanout: 2,
        },
      },
    );
    if (!result.ok) return errorResponse(mapError(result.error.kind));
    const [a, b] = result.value;
    if (a.data.points.length !== b.data.points.length)
      return errorResponse("unsupported_query");
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          interval: input.query.interval,
          a: { interval: a.data.interval, points: a.data.points.map(point) },
          b: { interval: b.data.interval, points: b.data.points.map(point) },
          delta: {
            points: a.data.points.map((value, ordinal) => {
              const previous = b.data.points[ordinal]!;
              return {
                ordinal,
                aTimestamp: new Date(value.timestampMs).toISOString(),
                bTimestamp: new Date(previous.timestampMs).toISOString(),
                views: relative(value.views, previous.views),
                sessions: relative(value.sessions, previous.sessions),
                visitors: relative(value.visitors, previous.visitors),
                bounces: relative(value.bounces, previous.bounces),
                totalDurationMs: relative(
                  value.totalDurationMs,
                  previous.totalDurationMs,
                ),
                durationViews: relative(
                  value.durationViews,
                  previous.durationViews,
                ),
              };
            }),
          },
        },
        meta: meta(
          requestId,
          resolved.a,
          resolved.b,
          input.timeZone,
          a.source === b.source ? a.source : "mixed",
          a.approximateVisitors || b.approximateVisitors,
        ),
      },
      requestId,
    );
  } catch {
    return errorResponse(
      context.signal?.aborted ? "request_cancelled" : "internal_error",
    );
  }
}

export async function handleTeamComparisonBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  dimension: string,
  reader: TeamComparisonBreakdownReader,
  context: QueryExecutionContext,
): Promise<Response> {
  if (!DIMENSIONS.has(dimension)) return errorResponse("validation_failed");
  const input = await parseComparison(
    request,
    principal,
    TeamComparisonBreakdownQueryDtoSchema,
  );
  if (isResponse(input)) return input;
  const filters = comparisonFilters(input);
  const resolved = ranges(
    input,
    context.capturedAtMs ?? context.now?.() ?? Date.now(),
  );
  if (!filters || !resolved) return errorResponse("validation_failed");
  try {
    const query = {
      a: {
        ...sharedInput(
          principal,
          filters.a,
          resolved.a,
          input.timeZone,
          undefined,
        ),
        dimension,
        limit: 200,
      },
      b: {
        ...sharedInput(
          principal,
          filters.b,
          resolved.b,
          input.timeZone,
          undefined,
        ),
        dimension,
        limit: 200,
      },
    };
    const result = await new AnalyticsQueryService().execute(
      {
        operation: "team.analytics.comparisonBreakdown",
        context: teamQueryContext(
          principal.teamId,
          "api-v1",
          principal.siteIds,
        ),
        query,
        provider: {
          execute: ({ query: providerQuery, execution: providerExecution }) =>
            Promise.all([
              reader({ ...providerQuery.a, signal: providerExecution.signal }),
              reader({ ...providerQuery.b, signal: providerExecution.signal }),
            ]),
        },
      },
      {
        ...context,
        operation: "team.analytics.comparisonBreakdown",
        cost: {
          rangeMs:
            Date.parse(resolved.a.to) -
            Date.parse(resolved.a.from) +
            Date.parse(resolved.b.to) -
            Date.parse(resolved.b.from),
          siteCount: principal.siteIds.length || 1,
          metricCount: 3,
          dimensionCardinality: 400,
          projectionFields: 3,
          pageLimit: input.query.limit,
          provider: "d1",
          batchFanout: 2,
        },
      },
    );
    if (!result.ok) return errorResponse(mapError(result.error.kind));
    const [a, b] = result.value;
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          dimension,
          items: breakdownUnion(a, b, input.query.limit, input.query.sort),
        },
        meta: meta(
          requestId,
          resolved.a,
          resolved.b,
          input.timeZone,
          "raw",
          false,
        ),
      },
      requestId,
    );
  } catch {
    return errorResponse(
      context.signal?.aborted ? "request_cancelled" : "internal_error",
    );
  }
}
