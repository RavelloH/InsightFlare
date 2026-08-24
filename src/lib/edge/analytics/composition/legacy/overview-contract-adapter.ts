import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeOverview,
  executeTrend,
  executeTypedApplicationOperation,
  type OverviewMetrics,
  type OverviewResult,
  siteQueryContext,
  type TrendPoint,
  type TrendResult,
} from "@/lib/edge/analytics/contract";
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
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  createOverviewReader,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
export { readLatestSiteActivity } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
export {
  createOverviewReader,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";

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
  const result = await executeTypedApplicationOperation<OverviewResult>(
    "overview",
    { context: queryContext, time: currentTime, filters },
    createTypedQueryProviderRegistry("overview", async () => {
      const value = await executeOverview(
        createOverviewReader(env, siteId, diagnostics),
        {
          context: queryContext,
          time: currentTime,
          filters,
          previousTime,
          detailInterval: includeDetail ? parseInterval(url) : undefined,
        },
      );
      if (!value.ok) throw new Error(value.error.kind);
      return {
        value: value.data,
        source: value.meta.source,
        approximateVisitors: value.meta.approximateVisitors,
      };
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
  const result = await executeTypedApplicationOperation<TrendResult>(
    "trend",
    { context: queryContext, time, filters },
    createTypedQueryProviderRegistry("trend", async () => {
      const value = await executeTrend(
        createOverviewReader(env, siteId, diagnostics),
        {
          context: queryContext,
          time,
          filters,
          interval: parseInterval(url),
        },
      );
      if (!value.ok) throw new Error(value.error.kind);
      return {
        value: value.data,
        source: value.meta.source,
        approximateVisitors: value.meta.approximateVisitors,
      };
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
