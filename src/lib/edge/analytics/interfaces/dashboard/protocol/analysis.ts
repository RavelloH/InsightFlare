import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type Interval,
  type PerformanceQuery,
  queryWindowToTime,
  type RetentionQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  parseInterval,
  parseLimit,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
export async function handleRetentionContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawGranularity =
    url.searchParams.get("granularity") ?? url.searchParams.get("interval");
  const allowedGranularities: readonly Interval[] = [
    "minute",
    "hour",
    "day",
    "week",
    "month",
  ];
  const query: RetentionQuery = {
    context: queryContext,
    time: queryWindowToTime(window),
    filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    granularity: allowedGranularities.includes(rawGranularity as Interval)
      ? (rawGranularity as Interval)
      : "week",
  };
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("retention", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
export async function handlePerformanceContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const interval = parseInterval(url);
  const query: PerformanceQuery = {
    context: queryContext,
    mode: "dashboard",
    time: queryWindowToTime(window),
    filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    interval,
    limit: parseLimit(url, 18, 50),
  };
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("performance", query);
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    ...result.data,
  });
}
