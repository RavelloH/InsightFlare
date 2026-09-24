import { funnelAnalysisCost } from "@/lib/edge/analytics/application/funnel-cost";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  type FunnelConfigV2,
  parseFilterUrlForAudience,
  type QueryWindow,
  queryWindowToTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { FunnelConfigValidationError } from "@/lib/edge/analytics/contract/funnel-config";
import {
  parseLimit,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  notAllowed,
  notFound,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { FunnelDefinitionResource } from "@/lib/edge/analytics/resources/funnels";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
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
    const result = await createEdgeSiteAnalyticsRuntime({
      env,
      siteId,
    }).execute("funnel-analysis", {
      context: queryContext,
      // Definition listing has no analytic time range. Keep it contract-bound
      // to the default dashboard range without altering its source query.
      time: queryWindowToTime(listWindow),
      filters: { version: 1, root: null },
      page: {
        limit: parseLimit(url, 50, 200),
        cursor: url.searchParams.get("cursor") ?? undefined,
      },
    });
    if (!result.ok) return queryErrorResponse(result.error);
    return jsonResponseWith(ctx!, { ok: true, data: result.data });
  }
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "funnel-analysis",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      funnelId,
    },
    { cost: funnelAnalysisCost(window.endExclusiveMs - window.startMs) },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  if (!("funnel" in result.data)) {
    throw new Error("funnel_analysis_result_mismatch");
  }
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
interface FunnelWriteBody {
  readonly name?: unknown;
  readonly filterDslVersion?: unknown;
  readonly progressionScope?: unknown;
  readonly conversionWindowMs?: unknown;
  readonly steps?: unknown;
}
function writeConfig(body: FunnelWriteBody): {
  name: string;
  config: FunnelConfigV2;
} | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const filterDslVersion = body.filterDslVersion ?? 1;
  const progressionScope = body.progressionScope ?? "session";
  const conversionWindowMs =
    body.conversionWindowMs === undefined ? null : body.conversionWindowMs;
  if (
    !name ||
    !Array.isArray(body.steps) ||
    filterDslVersion !== 1 ||
    (progressionScope !== "session" && progressionScope !== "visitor") ||
    (conversionWindowMs !== null &&
      (typeof conversionWindowMs !== "number" ||
        !Number.isFinite(conversionWindowMs)))
  ) {
    return null;
  }
  return {
    name,
    config: {
      filterDslVersion,
      progressionScope,
      conversionWindowMs,
      steps: body.steps as FunnelConfigV2["steps"],
    },
  };
}
async function readWriteBody(
  request: Request,
): Promise<FunnelWriteBody | Response> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return badRequest("Invalid JSON body");
    }
    return parsed as FunnelWriteBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
}
function invalidConfigResponse(error: unknown): Response | null {
  return error instanceof FunnelConfigValidationError
    ? badRequest("Invalid funnel configuration")
    : null;
}
async function handleFunnelCreate(
  resource: FunnelDefinitionResource,
  siteId: string,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const body = await readWriteBody(request);
  if (body instanceof Response) return body;
  const input = writeConfig(body);
  if (!input) return badRequest("Invalid funnel configuration");
  try {
    const funnel = await resource.create(siteId, input.name, input.config);
    return jsonResponseWith(ctx, { ok: true, data: { funnel } }, 201);
  } catch (error) {
    const response = invalidConfigResponse(error);
    if (response) return response;
    throw error;
  }
}
async function handleFunnelUpdate(
  resource: FunnelDefinitionResource,
  siteId: string,
  url: URL,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return badRequest("Funnel id is required");
  const current = await resource.get(siteId, funnelId);
  if (!current) return notFound();
  const body = await readWriteBody(request);
  if (body instanceof Response) return body;
  const filterDslVersion =
    body.filterDslVersion === undefined
      ? current.filterDslVersion
      : body.filterDslVersion;
  const progressionScope =
    body.progressionScope === undefined
      ? current.progressionScope
      : body.progressionScope;
  const conversionWindowMs =
    body.conversionWindowMs === undefined
      ? current.conversionWindowMs
      : body.conversionWindowMs;
  if (
    filterDslVersion !== 1 ||
    (progressionScope !== "session" && progressionScope !== "visitor") ||
    (conversionWindowMs !== null &&
      (typeof conversionWindowMs !== "number" ||
        !Number.isFinite(conversionWindowMs)))
  ) {
    return badRequest("Invalid funnel configuration");
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return badRequest("Name is required");
  }
  const name = body.name === undefined ? current.name : body.name.trim();
  if (!name) return badRequest("Name is required");
  const config: FunnelConfigV2 = {
    filterDslVersion,
    progressionScope,
    conversionWindowMs,
    steps: (body.steps ?? current.steps) as FunnelConfigV2["steps"],
  };
  try {
    const funnel = await resource.update(siteId, funnelId, name, config);
    return jsonResponseWith(ctx, { ok: true, data: { funnel } });
  } catch (error) {
    const response = invalidConfigResponse(error);
    if (response) return response;
    throw error;
  }
}
async function handleFunnelDelete(
  resource: FunnelDefinitionResource,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return badRequest("Funnel id is required");
  await resource.archive(siteId, funnelId);
  return jsonResponseWith(ctx, { ok: true });
}
/** Private Funnel definition resource protocol. */
export async function handleFunnel(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  request?: Request,
): Promise<Response> {
  const resource: FunnelDefinitionResource = createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).resources.funnels;
  const method = request?.method ?? "GET";
  if (method === "GET") {
    return handleFunnelAnalysisContract(
      env,
      siteId,
      url,
      ctx,
      siteQueryContext(siteId, "private-dashboard"),
    );
  }
  if (method === "POST" && request)
    return handleFunnelCreate(resource, siteId, request, ctx);
  if (method === "PATCH" && request)
    return handleFunnelUpdate(resource, siteId, url, request, ctx);
  if (method === "DELETE")
    return handleFunnelDelete(resource, siteId, url, ctx);
  return notAllowed();
}
