import {
  type FilterDocument,
  parseFilterUrlForAudience,
} from "@/lib/edge/query-contract";
import {
  executeOverview,
  executeTrend,
  executeTypedApplicationResult,
  type OverviewMetrics,
  type OverviewReader,
  type OverviewReaderInput,
  type QueryTime,
  siteQueryContext,
  type TrendPoint,
  type TrendReaderInput,
  type TrendReaderResult,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import type { QueryWindow, TrendAggregateRow } from "./core";
import {
  badRequest,
  jsonResponseWith,
  parseBooleanFlag,
  parseInterval,
  parseWindow,
  percentChange,
  previousComparableWindow,
  queryErrorResponse,
  type ResponseContext,
} from "./core";
import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "./diagnostics";
import {
  queryLatestSiteActivity,
  queryOverviewAggregate,
  queryTrendAggregate,
} from "./overview";

export function toQueryTime(window: QueryWindow): QueryTime {
  return {
    range: {
      startMs: window.startMs as QueryTime["range"]["startMs"],
      endExclusiveMs:
        window.endExclusiveMs as QueryTime["range"]["endExclusiveMs"],
    },
    reportingTimeZone: window.timeZone as QueryTime["reportingTimeZone"],
    capturedAtMs: window.nowMs as QueryTime["capturedAtMs"],
  };
}

function sourceFromDiagnostic(
  result: { diagnosticSource?: "raw" | "rollup" } | undefined,
): "raw" | "rollup" {
  return result?.diagnosticSource ?? "raw";
}

function aggregateMetrics(row: OverviewMetrics) {
  return {
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
    bounces: row.bounces,
    totalDurationMs: row.totalDurationMs,
    avgDurationMs:
      row.sessions > 0 ? Math.round(row.totalDurationMs / row.sessions) : 0,
    bounceRate: row.sessions > 0 ? row.bounces / row.sessions : 0,
    approximateVisitors: false,
  };
}

function trendRows(points: readonly TrendPoint[]) {
  return points.map((point) => ({
    bucket: point.bucket,
    timestampMs: point.timestampMs,
    views: point.views,
    visitors: point.visitors,
    sessions: point.sessions,
    bounces: point.bounces,
    totalDurationMs: point.totalDurationMs,
    avgDurationMs:
      point.sessions > 0
        ? Math.round(point.totalDurationMs / point.sessions)
        : 0,
    source: "detail" as const,
  }));
}

export function createOverviewReader(
  env: Env,
  siteId: string,
  diagnostics: D1ReadDiagnostics = createD1ReadDiagnostics(),
): OverviewReader {
  return {
    async readOverview(input: OverviewReaderInput) {
      const result = await queryOverviewAggregate(
        env,
        siteId,
        {
          startMs: input.time.range.startMs,
          endExclusiveMs: input.time.range.endExclusiveMs,
          nowMs: input.time.capturedAtMs,
          timeZone: input.time.reportingTimeZone,
        },
        input.filters,
        diagnostics,
      );
      return {
        value: {
          views: result.value.views,
          sessions: result.value.sessions,
          visitors: result.value.visitors,
          bounces: result.value.bounces,
          totalDurationMs: result.value.totalDuration,
          durationViews: result.value.durationViews,
        },
        source: sourceFromDiagnostic(result),
        approximateVisitors: Boolean(result.approximateVisitors),
      };
    },
    async readTrend(input: TrendReaderInput): Promise<TrendReaderResult> {
      const result = await queryTrendAggregate(
        env,
        siteId,
        {
          startMs: input.time.range.startMs,
          endExclusiveMs: input.time.range.endExclusiveMs,
          nowMs: input.time.capturedAtMs,
          timeZone: input.time.reportingTimeZone,
        },
        input.interval,
        input.filters,
        diagnostics,
      );
      return {
        value: result.value.map((row: TrendAggregateRow) => ({
          bucket: row.bucket,
          timestampMs: row.timestampMs as TrendPoint["timestampMs"],
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
          bounces: row.bounces,
          totalDurationMs: row.totalDuration,
          durationViews: row.durationViews,
        })),
        source: sourceFromDiagnostic(result),
        approximateVisitors: Boolean(result.approximateVisitors),
      };
    },
  };
}

/** Typed provider fragment used only by the team-site composite reader. */
export async function readLatestSiteActivity(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics: D1ReadDiagnostics = createD1ReadDiagnostics(),
): Promise<number | null> {
  return queryLatestSiteActivity(env, siteId, window, filters, diagnostics);
}

export async function handleOverviewContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const diagnostics = createD1ReadDiagnostics();
  const currentTime = toQueryTime(window);
  const previousTime = parseBooleanFlag(url, "includeChange")
    ? toQueryTime(previousComparableWindow(window))
    : undefined;
  const includeDetail = parseBooleanFlag(url, "includeDetail");
  const result = await executeTypedApplicationResult(
    "overview",
    { context: queryContext, time: currentTime, filters },
    () =>
      executeOverview(createOverviewReader(env, siteId, diagnostics), {
        context: queryContext,
        time: currentTime,
        filters,
        previousTime,
        detailInterval: includeDetail ? parseInterval(url) : undefined,
      }),
  );
  if (!result.ok) return queryErrorResponse(result.error);

  const current = aggregateMetrics(result.data.current);
  const payload: Record<string, unknown> = { ok: true, data: current };
  if (result.data.previous) {
    const previous = aggregateMetrics(result.data.previous);
    payload.previousData = previous;
    payload.changeRates = {
      views: percentChange(current.views, previous.views),
      sessions: percentChange(current.sessions, previous.sessions),
      visitors: percentChange(current.visitors, previous.visitors),
      bounces: percentChange(current.bounces, previous.bounces),
      bounceRate: percentChange(current.bounceRate, previous.bounceRate),
      avgDurationMs: percentChange(
        current.avgDurationMs,
        previous.avgDurationMs,
      ),
    };
  }
  if (result.data.detail) {
    payload.detail = {
      interval: result.data.detail.interval,
      data: trendRows(result.data.detail.points),
    };
  }
  return jsonResponseWith(
    ctx!,
    payload,
    200,
    analyticsDiagnosticHeaders(result.meta.source, diagnostics),
  );
}

export async function handleTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const diagnostics = createD1ReadDiagnostics();
  const time = toQueryTime(window);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationResult(
    "trend",
    { context: queryContext, time, filters },
    () =>
      executeTrend(createOverviewReader(env, siteId, diagnostics), {
        context: queryContext,
        time,
        filters,
        interval: parseInterval(url),
      }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(
    ctx!,
    {
      ok: true,
      interval: result.data.interval,
      data: trendRows(result.data.points),
    },
    200,
    analyticsDiagnosticHeaders(result.meta.source, diagnostics),
  );
}
