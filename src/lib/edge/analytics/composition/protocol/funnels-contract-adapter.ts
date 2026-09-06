import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
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
  FUNNEL_SQL_MAX_BINDINGS,
  FUNNEL_SQL_STRUCTURAL_BUDGET,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-planner";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { appNow } from "@/lib/edge/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { ONE_DAY_MS } from "@/lib/edge/utils";

export { handleFunnel } from "@/lib/edge/analytics/providers/d1/internal/funnels";

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
    const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
      readonly funnels: readonly unknown[];
    }>("funnel-analysis", {
      context: queryContext,
      // Definition listing has no analytic time range. Keep it contract-bound
      // to the default dashboard range without altering its source query.
      time: toQueryTime(listWindow),
      filters: { version: 1, root: null },
    });
    if (!result.ok) return queryErrorResponse(result.error);
    return jsonResponseWith(ctx!, { ok: true, data: result.data });
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly funnel: Record<string, unknown> | null;
    readonly analysis: Record<string, unknown> | null;
  }>(
    "funnel-analysis",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters,
      funnelId,
    },
    {
      cost: {
        rangeMs: window.endExclusiveMs - window.startMs,
        siteCount: 1,
        metricCount: 1,
        provider: "d1",
        funnelStepCount: FUNNEL_SQL_STRUCTURAL_BUDGET.maxSteps,
        funnelCteCount: FUNNEL_SQL_STRUCTURAL_BUDGET.maxFunnelCtes,
        funnelSqlLength: FUNNEL_SQL_STRUCTURAL_BUDGET.maxSqlLength,
        funnelBindingCount: FUNNEL_SQL_MAX_BINDINGS,
        funnelWorstCase: true,
      },
    },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  if (!result.data.funnel) return notFound();
  if (!result.data.analysis) return badRequest("Funnel has fewer than 2 steps");
  return jsonResponseWith(ctx!, {
    ok: true,
    data: {
      funnel: result.data.funnel,
      analysis: result.data.analysis,
    },
  });
}
