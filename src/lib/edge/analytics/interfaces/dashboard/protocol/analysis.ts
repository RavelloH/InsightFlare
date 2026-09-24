import { createSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  type PerformanceDashboardResult,
  queryWindowToTime,
  type RetentionResult,
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
  const result = await createSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute<RetentionResult>("retention", {
    context: queryContext,
    time: queryWindowToTime(window),
    filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    granularity:
      url.searchParams.get("granularity") ??
      url.searchParams.get("interval") ??
      "week",
  } as BaseQuery & { readonly granularity: string });
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
  const result = await createSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute<PerformanceDashboardResult>("performance", {
    context: queryContext,
    time: queryWindowToTime(window),
    filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    interval,
    limit: parseLimit(url, 18, 50),
  } as BaseQuery & {
    readonly interval: ReturnType<typeof parseInterval>;
    readonly limit: number;
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    ...result.data,
  });
}
