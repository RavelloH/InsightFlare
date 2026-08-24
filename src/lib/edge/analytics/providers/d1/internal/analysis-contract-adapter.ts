import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  parseInterval,
  parseLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "./core";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "./journey-retention";
import { toQueryTime } from "./overview-contract-adapter";
import { queryPerformanceDashboardFromD1 } from "./performance";

export async function handleRetentionContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await executeTypedApplicationOperation<RetentionResult>(
    "retention",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    },
    createTypedQueryProviderRegistry("retention", async () => ({
      value: await queryRetentionFromD1(
        env,
        siteId,
        window,
        parseFilterUrlForAudience(queryContext.policy.audience, url),
        parseRetentionGranularity(
          url.searchParams.get("granularity") ??
            url.searchParams.get("interval"),
        ),
      ),
    })),
  );
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
  const result = await executeTypedApplicationOperation<
    Awaited<ReturnType<typeof queryPerformanceDashboardFromD1>>
  >(
    "performance",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: parseFilterUrlForAudience(queryContext.policy.audience, url),
    },
    createTypedQueryProviderRegistry("performance", async () => ({
      value: await queryPerformanceDashboardFromD1(
        env,
        siteId,
        window,
        interval,
        parseFilterUrlForAudience(queryContext.policy.audience, url),
        parseLimit(url, 18, 50),
      ),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    ...result.data,
  });
}
