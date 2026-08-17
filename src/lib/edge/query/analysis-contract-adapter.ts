import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  parseFilters,
  parseInterval,
  parseLimit,
  parseWindow,
  type ResponseContext,
} from "./core";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "./journey-retention";
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";
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
  const result = await executeQueryOperation<RetentionResult>(
    "retention",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(parseFilters(url)),
    },
    async () => ({
      value: await queryRetentionFromD1(
        env,
        siteId,
        window,
        parseFilters(url),
        parseRetentionGranularity(
          url.searchParams.get("granularity") ??
            url.searchParams.get("interval"),
        ),
      ),
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const result = await executeQueryOperation(
    "performance",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(parseFilters(url)),
    },
    async () => ({
      value: await queryPerformanceDashboardFromD1(
        env,
        siteId,
        window,
        interval,
        parseFilters(url),
        parseLimit(url, 18, 50),
      ),
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, {
    ok: true,
    interval,
    ...result.data,
  });
}
