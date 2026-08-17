import { appNow } from "@/lib/edge/e2e-clock";
import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";
import { ONE_DAY_MS } from "@/lib/edge/utils";

import {
  badRequest,
  jsonResponseWith,
  notFound,
  parseFilters,
  parseWindow,
  type QueryWindow,
  type ResponseContext,
} from "./core";
import {
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitions,
} from "./funnels";
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";

/** Read-only funnel protocol mapping. Create/delete remain commands outside
 * the analytics query contract. */
export async function handleFunnelAnalysisContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) {
    // Definition listing has no analytic time range. Reproduce parseWindow's
    // no-param default window (now-24h -> now, timeZone falls back to UTC)
    // without requiring a throwaway URL.
    const nowMs = appNow();
    const listWindow: QueryWindow = {
      startMs: Math.floor(nowMs - ONE_DAY_MS),
      endExclusiveMs: Math.floor(nowMs),
      nowMs,
      timeZone: "UTC",
    };
    const result = await executeQueryOperation(
      "funnel-analysis",
      {
        context: queryContext,
        // Definition listing has no analytic time range. Keep it contract-bound
        // to the default dashboard range without altering its source query.
        time: toQueryTime(listWindow),
        filters: legacyFilters({}),
      },
      async () => ({
        value: { funnels: await queryFunnelDefinitions(env, siteId) },
      }),
    );
    if (!result.ok) return badRequest(result.error.kind);
    return jsonResponseWith(ctx!, { ok: true, ...result.data });
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "funnel-analysis",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
      const funnel = await queryFunnelDefinition(env, siteId, funnelId);
      return {
        value: {
          funnel,
          analysis:
            funnel && funnel.steps.length >= 2
              ? await queryFunnelAnalysis(
                  env,
                  siteId,
                  window,
                  filters,
                  funnel.steps,
                )
              : null,
        },
      };
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
  if (!result.data.funnel) return notFound();
  if (!result.data.analysis) return badRequest("Funnel has fewer than 2 steps");
  return jsonResponseWith(ctx!, {
    ok: true,
    funnel: result.data.funnel,
    analysis: result.data.analysis,
  });
}
