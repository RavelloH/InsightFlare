import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  analyticsDiagnosticHeaders,
  createAnalyticsReadDiagnostics,
} from "@/lib/edge/analytics/composition";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type OverviewMetrics,
  type OverviewQuery,
  percentChange,
  previousComparableWindow,
  queryWindowToTime,
  siteQueryContext,
  type TrendPoint,
  type TrendQuery,
} from "@/lib/edge/analytics/contract";
import {
  parseBooleanFlag,
  parseInterval,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
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
  const diagnostics = createAnalyticsReadDiagnostics();
  const currentTime = queryWindowToTime(window);
  const previousTime = parseBooleanFlag(url, "includeChange")
    ? queryWindowToTime(previousComparableWindow(window))
    : undefined;
  const includeDetail = parseBooleanFlag(url, "includeDetail");
  const query = {
    context: queryContext,
    time: currentTime,
    filters,
    previousTime,
    detailInterval: includeDetail ? parseInterval(url) : undefined,
  } satisfies OverviewQuery;
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
    diagnostics,
  }).execute("overview", query);
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
  const diagnostics = createAnalyticsReadDiagnostics();
  const time = queryWindowToTime(window);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const query = {
    context: queryContext,
    time,
    filters,
    interval: parseInterval(url),
  } satisfies TrendQuery;
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
    diagnostics,
  }).execute("trend", query);
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
