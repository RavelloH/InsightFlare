import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1-site-query-runtime";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  type BaseQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  parseInterval,
  parseLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { RetentionResult } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import type { queryPerformanceDashboardFromD1 } from "@/lib/edge/analytics/providers/d1/internal/performance";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
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
  const result = await createD1SiteQueryRuntime({
    env,
    siteId,
  }).execute<RetentionResult>("retention", {
    context: queryContext,
    time: toQueryTime(window),
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Awaited<ReturnType<typeof queryPerformanceDashboardFromD1>>
  >("performance", {
    context: queryContext,
    time: toQueryTime(window),
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
