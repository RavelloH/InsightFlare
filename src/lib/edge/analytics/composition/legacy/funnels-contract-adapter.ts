import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  notFound,
  parseWindow,
  queryErrorResponse,
  type QueryWindow,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitions,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { appNow } from "@/lib/edge/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { ONE_DAY_MS } from "@/lib/edge/utils";

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
    const result = await executeTypedApplicationOperation<{
      readonly funnels: Awaited<ReturnType<typeof queryFunnelDefinitions>>;
    }>(
      "funnel-analysis",
      {
        context: queryContext,
        // Definition listing has no analytic time range. Keep it contract-bound
        // to the default dashboard range without altering its source query.
        time: toQueryTime(listWindow),
        filters: { version: 1, root: null },
      },
      createTypedQueryProviderRegistry("funnel-analysis", async () => ({
        value: { funnels: await queryFunnelDefinitions(env, siteId) },
      })),
    );
    if (!result.ok) return queryErrorResponse(result.error);
    return jsonResponseWith(ctx!, { ok: true, ...result.data });
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly funnel: Awaited<ReturnType<typeof queryFunnelDefinition>>;
    readonly analysis: Awaited<ReturnType<typeof queryFunnelAnalysis>> | null;
  }>(
    "funnel-analysis",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("funnel-analysis", async () => {
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
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  if (!result.data.funnel) return notFound();
  if (!result.data.analysis) return badRequest("Funnel has fewer than 2 steps");
  return jsonResponseWith(ctx!, {
    ok: true,
    funnel: result.data.funnel,
    analysis: result.data.analysis,
  });
}
