import type { Context } from "hono";
import { Hono } from "hono";

import { createAnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import {
  handlePlannedSiteAnalyticsSchema,
  handlePlannedTeamAnalyticsSchema,
} from "@/lib/api-v1/analytics-schema-handler";
import { requireScope } from "@/lib/api-v1/auth-helpers";
import { handleSiteComparisonBreakdown } from "@/lib/api-v1/comparison-breakdown-handler";
import { handleSiteOverviewComparison } from "@/lib/api-v1/comparison-handler";
import { handleSiteTimeseriesComparison } from "@/lib/api-v1/comparison-timeseries-handler";
import { dispatchApiV1CoreRoute } from "@/lib/api-v1/core-dispatcher";
import { TypedBatchRequestSchema } from "@/lib/api-v1/dto/batch";
import { handlePlannedSiteFunnelAnalysis } from "@/lib/api-v1/funnel-analysis-handler";
import { handlePlannedSiteOverview } from "@/lib/api-v1/overview-handler";
import {
  API_V1_BATCH_BODY_MAX_BYTES,
  API_V1_BATCH_ITEM_BODY_MAX_BYTES,
  inspectJsonBudget,
  readBoundedBody,
  serializedUtf8ByteLength,
} from "@/lib/api-v1/request-budget";
import { handlePlannedResourceRoute } from "@/lib/api-v1/resource-handler";
import { handlePlannedSavedFilters } from "@/lib/api-v1/saved-filters-handler";
import { handlePlannedSiteBreakdown } from "@/lib/api-v1/site-breakdown-handler";
import { handlePlannedSiteCrossBreakdown } from "@/lib/api-v1/site-cross-breakdown-handler";
import {
  handlePlannedSiteEventDetail,
  handlePlannedSiteEventFields,
  handlePlannedSiteEventFieldValues,
  handlePlannedSiteEventsSearch,
  handlePlannedSiteEventsSummary,
  handlePlannedSiteEventsTimeseries,
  handlePlannedSiteEventTypeDetail,
  handlePlannedSiteEventTypes,
  handlePlannedSiteFilterValues,
  handlePlannedSitePages,
  handlePlannedSitePerformanceBreakdown,
  handlePlannedSitePerformanceSummary,
  handlePlannedSitePerformanceTimeseries,
  handlePlannedSiteRealtimeActiveVisitors,
  handlePlannedSiteRealtimeEvents,
  handlePlannedSiteRealtimeSessions,
  handlePlannedSiteRealtimeSnapshot,
  handlePlannedSiteReferrers,
  handlePlannedSiteRetention,
  handlePlannedSiteSessionDetail,
  handlePlannedSiteSessionEvents,
  handlePlannedSiteSessionsSearch,
  handlePlannedSiteVisitorDetail,
  handlePlannedSiteVisitorEvents,
  handlePlannedSiteVisitorSessions,
  handlePlannedSiteVisitorsSearch,
} from "@/lib/api-v1/site-list-handler";
import { handleTeamBreakdown } from "@/lib/api-v1/team-breakdown-handler";
import {
  handleTeamComparisonBreakdown,
  handleTeamComparisonOverview,
  handleTeamComparisonTimeseries,
} from "@/lib/api-v1/team-comparison-handler";
import { handlePlannedTeamOverview } from "@/lib/api-v1/team-overview-handler";
import { handlePlannedTeamSites } from "@/lib/api-v1/team-sites-handler";
import { handlePlannedTeamTimeseries } from "@/lib/api-v1/team-timeseries-handler";
import { handlePlannedSiteTimeseries } from "@/lib/api-v1/timeseries-handler";
import {
  executeTypedBatch,
  TypedBatchValidationError,
} from "@/lib/api-v1/typed-batch";
import { jsonError, jsonSuccess } from "@/lib/api-v1/wire-helpers";
import {
  createOverviewReader,
  readSiteBreakdown,
  readSiteCrossBreakdown,
  readSiteEventDetail,
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventRecords,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
  readSiteFilterValues,
  readSiteFunnelAnalysis,
  readSitePages,
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
  readSiteReferrers,
  readSiteRetention,
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
  readTeamBreakdown,
  readTeamOverview,
  readTeamSites,
  readTeamTimeseries,
} from "@/lib/edge/analytics/api-v1-provider";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { authenticateApiKeyMiddleware } from "@/lib/hono/middleware/api-key";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext } from "@/lib/hono/utils/context";

function principal(c: Context<AppEnv>) {
  const value = c.get("apiPrincipal");
  if (!value) {
    throw new Error("api principal context missing");
  }
  return value;
}

function resourceNotFound(c: Context<AppEnv>) {
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    c.req.raw,
  );
}

function withSiteId(
  c: Context<AppEnv>,
  handler: (siteId: string) => Promise<Response>,
) {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handler(siteId);
}

export const v1Routes = new Hono<AppEnv>();

// Batch children are routed through the same Hono registration without a
// second API-key lookup. The map is request-local and never crosses the edge.
const internalBatchPrincipals = new WeakMap<Request, ApiKeyPrincipal>();

async function dispatchTypedBatchRequest(
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
  apiPrincipal: ApiKeyPrincipal,
): Promise<Response> {
  const source = new URL(request.url);
  const mountedPath = source.pathname.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
  const routedUrl = new URL(source);
  routedUrl.pathname = mountedPath;
  const routedRequest = new Request(routedUrl, request);
  internalBatchPrincipals.set(routedRequest, apiPrincipal);
  try {
    return await v1Routes.fetch(routedRequest, env, ctx);
  } finally {
    internalBatchPrincipals.delete(routedRequest);
  }
}

function typedTeamOverview(c: Context<AppEnv>): Promise<Response> {
  return handlePlannedTeamOverview(
    c.req.raw,
    principal(c),
    (input) =>
      readTeamOverview({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamTimeseries(c: Context<AppEnv>): Promise<Response> {
  return handlePlannedTeamTimeseries(
    c.req.raw,
    principal(c),
    (input) =>
      readTeamTimeseries({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        interval: input.interval,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamSites(c: Context<AppEnv>): Promise<Response> {
  return handlePlannedTeamSites(
    c.req.raw,
    principal(c),
    (input) =>
      readTeamSites({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        interval: input.interval,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamBreakdown(c: Context<AppEnv>): Promise<Response> {
  const dimension = c.req.param("dimension");
  if (!dimension) return Promise.resolve(resourceNotFound(c));
  return handleTeamBreakdown(
    c.req.raw,
    principal(c),
    dimension,
    (input) =>
      readTeamBreakdown({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        dimension: input.dimension,
        limit: input.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamComparisonOverview(c: Context<AppEnv>): Promise<Response> {
  return handleTeamComparisonOverview(
    c.req.raw,
    principal(c),
    (input) =>
      readTeamOverview({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamComparisonTimeseries(c: Context<AppEnv>): Promise<Response> {
  return handleTeamComparisonTimeseries(
    c.req.raw,
    principal(c),
    (input) =>
      readTeamTimeseries({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        interval: input.interval,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamComparisonBreakdown(c: Context<AppEnv>): Promise<Response> {
  const dimension = c.req.param("dimension");
  if (!dimension) return Promise.resolve(resourceNotFound(c));
  return handleTeamComparisonBreakdown(
    c.req.raw,
    principal(c),
    dimension,
    (input) =>
      readTeamBreakdown({
        env: c.env,
        teamId: input.teamId,
        allowedSiteIds: input.allowedSiteIds,
        dimension: input.dimension,
        limit: input.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

v1Routes.get("/", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.root",
    request: c.req.raw,
    env: c.env,
  }),
);
v1Routes.use("/*", async (c, next) => {
  const internalPrincipal = internalBatchPrincipals.get(c.req.raw);
  if (internalPrincipal) {
    c.set("apiPrincipal", internalPrincipal);
    await next();
    return;
  }
  return authenticateApiKeyMiddleware()(c, next);
});

v1Routes.all("/token", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.token.get",
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
  }),
);
v1Routes.all("/token/check", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.token.check",
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
  }),
);
v1Routes.all("/capabilities", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.capabilities",
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
  }),
);
v1Routes.all("/team", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.team.get",
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
  }),
);
v1Routes.all("/team/usage", (c) =>
  dispatchApiV1CoreRoute({
    routeId: "core.team.usage",
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
  }),
);
v1Routes.post("/team/analytics/breakdowns/:dimension", typedTeamBreakdown);
v1Routes.post(
  "/team/analytics/comparison/overview",
  typedTeamComparisonOverview,
);
v1Routes.post(
  "/team/analytics/comparison/timeseries",
  typedTeamComparisonTimeseries,
);
v1Routes.post(
  "/team/analytics/comparison/breakdowns/:dimension",
  typedTeamComparisonBreakdown,
);
v1Routes.post("/team/analytics/overview", typedTeamOverview);
v1Routes.post("/team/analytics/timeseries", typedTeamTimeseries);
v1Routes.post("/team/analytics/sites", typedTeamSites);
v1Routes.all("/team/analytics/schema", (c) =>
  handlePlannedTeamAnalyticsSchema(c.req.raw, principal(c)),
);
v1Routes.post("/sites/:siteId/analytics/comparison/overview", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handleSiteOverviewComparison(
    c.req.raw,
    principal(c),
    siteId,
    createOverviewReader(c.env, siteId),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/comparison/timeseries", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handleSiteTimeseriesComparison(
    c.req.raw,
    principal(c),
    siteId,
    createOverviewReader(c.env, siteId),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post(
  "/sites/:siteId/analytics/comparison/breakdowns/:dimension",
  (c) => {
    const siteId = c.req.param("siteId");
    const dimension = c.req.param("dimension");
    if (!siteId || !dimension) return resourceNotFound(c);
    return handleSiteComparisonBreakdown(
      c.req.raw,
      principal(c),
      siteId,
      dimension,
      (input) =>
        readSiteBreakdown({
          env: c.env,
          siteId: input.siteId,
          dimension: input.dimension,
          limit: input.limit,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, principal(c)),
    );
  },
);
v1Routes.post("/batch", async (c) => {
  const denied = requireScope(principal(c).scopes, "analytics:read", c.req.raw);
  if (denied) return denied;

  // Read and cap the actual stream before looking at media type or parsing
  // recursive JSON.  This precedence is intentional: a declared-size and
  // media-type violation must deterministically return 413.
  const bounded = await readBoundedBody(c.req.raw, API_V1_BATCH_BODY_MAX_BYTES);
  if (!bounded.ok && bounded.reason === "too_large") {
    return jsonError(
      "payload_too_large",
      "Batch request body exceeds the maximum size",
      413,
      { maxBytes: API_V1_BATCH_BODY_MAX_BYTES },
      c.req.raw,
    );
  }
  const contentType = c.req.header("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return jsonError(
      "unsupported_media_type",
      "Batch requests require application/json",
      415,
      undefined,
      c.req.raw,
    );
  }
  const encoding = c.req.header("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    return jsonError(
      "unsupported_media_type",
      "Batch requests must not use an unsupported Content-Encoding",
      415,
      undefined,
      c.req.raw,
    );
  }
  if (!bounded.ok) {
    return jsonError(
      "invalid_json",
      "Invalid JSON body",
      400,
      undefined,
      c.req.raw,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
    );
  } catch {
    return jsonError(
      "invalid_json",
      "Invalid JSON body",
      400,
      undefined,
      c.req.raw,
    );
  }
  const budget = inspectJsonBudget(raw);
  if (!budget.ok) {
    return jsonError(
      "payload_too_large",
      "Batch JSON structure exceeds the configured budget",
      413,
      { reason: budget.reason },
      c.req.raw,
    );
  }
  const parsed = TypedBatchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      "validation_failed",
      "Invalid batch request",
      422,
      undefined,
      c.req.raw,
    );
  }
  let itemBytes = 0;
  for (const item of parsed.data.requests) {
    const bytes =
      item.body === undefined ? 2 : serializedUtf8ByteLength(item.body);
    if (bytes > API_V1_BATCH_ITEM_BODY_MAX_BYTES) {
      return jsonError(
        "payload_too_large",
        "A batch item body exceeds the maximum size",
        413,
        { itemId: item.id, maxBytes: API_V1_BATCH_ITEM_BODY_MAX_BYTES },
        c.req.raw,
      );
    }
    itemBytes += bytes;
    if (itemBytes > API_V1_BATCH_BODY_MAX_BYTES) {
      return jsonError(
        "payload_too_large",
        "Batch item bodies exceed the total size budget",
        413,
        { maxBytes: API_V1_BATCH_BODY_MAX_BYTES },
        c.req.raw,
      );
    }
  }
  try {
    const result = await executeTypedBatch(
      c.req.raw,
      principal(c),
      parsed.data,
      {
        signal: c.req.raw.signal,
        dispatch: (_item, context) =>
          dispatchTypedBatchRequest(
            context.request,
            c.env,
            executionContext(c),
            context.principal,
          ),
      },
    );
    return jsonSuccess(
      { responses: result.responses },
      {
        request: c.req.raw,
        meta: { partialFailure: result.partialFailure },
      },
    );
  } catch (error) {
    if (error instanceof TypedBatchValidationError) {
      return jsonError(
        error.code,
        "One or more batch children are not allowed",
        422,
        { itemIds: error.itemIds },
        c.req.raw,
      );
    }
    return jsonError(
      "internal_error",
      "Batch execution failed",
      500,
      undefined,
      c.req.raw,
    );
  }
});
v1Routes.all("/batch", (c) => {
  const response = jsonError(
    "method_not_allowed",
    "Method Not Allowed",
    405,
    undefined,
    c.req.raw,
  );
  response.headers.set("Allow", "POST");
  return response;
});
// API v1 exposes only the typed route registry. Legacy wildcard executors are
// intentionally absent so old paths fail as resource_not_found.
v1Routes.post("/sites/:siteId/analytics/overview", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteOverview(
    c.req.raw,
    principal(c),
    siteId,
    createOverviewReader(c.env, siteId),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.all("/sites/:siteId/analytics/schema", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteAnalyticsSchema(c.req.raw, principal(c), siteId);
});
v1Routes.all("/sites/:siteId/saved-filters", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSavedFilters(c.req.raw, c.env, principal(c), siteId);
});
v1Routes.all("/sites/:siteId/saved-filters/:savedFilterId", (c) => {
  const siteId = c.req.param("siteId");
  const savedFilterId = c.req.param("savedFilterId");
  if (!siteId || !savedFilterId) return resourceNotFound(c);
  return handlePlannedSavedFilters(
    c.req.raw,
    c.env,
    principal(c),
    siteId,
    savedFilterId,
  );
});
v1Routes.post("/sites/:siteId/analytics/timeseries", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteTimeseries(
    c.req.raw,
    principal(c),
    siteId,
    createOverviewReader(c.env, siteId),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/breakdowns/:dimension", (c) => {
  const siteId = c.req.param("siteId");
  const dimension = c.req.param("dimension");
  if (!siteId || !dimension) return resourceNotFound(c);
  return handlePlannedSiteBreakdown(
    c.req.raw,
    principal(c),
    siteId,
    dimension,
    (input) =>
      readSiteBreakdown({
        env: c.env,
        siteId: input.siteId,
        dimension: input.dimension,
        limit: input.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/cross-breakdowns", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteCrossBreakdown(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteCrossBreakdown({
        env: c.env,
        siteId: input.siteId,
        primaryDimension: input.primaryDimension,
        secondaryDimension: input.secondaryDimension,
        primaryLimit: input.primaryLimit,
        secondaryLimit: input.secondaryLimit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/pages", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSitePages(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSitePages({
        env: c.env,
        siteId: input.siteId,
        limit: input.limit,
        includeDetails: input.includeDetails,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/referrers", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteReferrers(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteReferrers({
        env: c.env,
        siteId: input.siteId,
        limit: input.limit,
        includeFullUrl: input.includeFullUrl,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/filter-values", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteFilterValues(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteFilterValues({
        env: c.env,
        siteId: input.siteId,
        field: input.field,
        search: input.search,
        limit: input.page.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/retention/cohorts", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteRetention(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteRetention({
        env: c.env,
        siteId: input.siteId,
        granularity: input.granularity,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/funnel-analysis", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteFunnelAnalysis(
    c.req.raw,
    principal(c),
    siteId,
    (input) => readSiteFunnelAnalysis({ env: c.env, ...input }),
    createAnalysisDefinitionReader(c.env, principal(c)),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/performance/summary", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSitePerformanceSummary(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSitePerformanceSummary({
        env: c.env,
        siteId: input.siteId,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/performance/timeseries", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSitePerformanceTimeseries(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSitePerformanceTimeseries({
        env: c.env,
        siteId: input.siteId,
        interval: input.interval,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post(
  "/sites/:siteId/analytics/performance/breakdowns/:dimension",
  (c) => {
    const siteId = c.req.param("siteId");
    const dimension = c.req.param("dimension");
    if (!siteId || !dimension) return resourceNotFound(c);
    return handlePlannedSitePerformanceBreakdown(
      c.req.raw,
      principal(c),
      siteId,
      (input) =>
        readSitePerformanceBreakdown({
          env: c.env,
          siteId: input.siteId,
          dimension,
          metric: input.metric,
          limit: input.limit,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, principal(c)),
    );
  },
);
v1Routes.post("/sites/:siteId/analytics/events/summary", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventsSummary(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventsSummary({
        env: c.env,
        siteId: input.siteId,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/events/timeseries", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventsTimeseries(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventsTimeseries({
        env: c.env,
        siteId: input.siteId,
        interval: input.interval,
        limit: input.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/event-types", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventTypes(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventTypes({
        env: c.env,
        siteId: input.siteId,
        search: input.search,
        limit: input.page.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/event-types/detail", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventTypeDetail(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventTypeDetail({
        env: c.env,
        siteId: input.siteId,
        eventName: input.eventName,
        interval: input.interval,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/event-types/fields", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventFields(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventFields({
        env: c.env,
        siteId: input.siteId,
        eventName: input.eventName,
        limit: input.page.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/event-types/field-values", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventFieldValues(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventFieldValues({
        env: c.env,
        siteId: input.siteId,
        eventName: input.eventName,
        fieldPath: input.fieldPath,
        fieldValueType: input.fieldValueType,
        search: input.search,
        limit: input.page.limit,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/events/search", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventsSearch(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventRecords({
        env: c.env,
        siteId: input.siteId,
        search: input.search,
        eventName: input.eventName,
        sort: input.sort,
        page: input.page,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
        filters: input.filters,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/events/detail", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteEventDetail(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteEventDetail({
        env: c.env,
        siteId: input.siteId,
        eventId: input.eventId,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/realtime/snapshot", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteRealtimeSnapshot(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteRealtimeSnapshot({
        env: c.env,
        siteId: input.siteId,
        startMs: input.startMs,
        endExclusiveMs: input.endExclusiveMs,
        limit: input.limit,
        signal: input.signal,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/realtime/active-visitors", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteRealtimeActiveVisitors(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteRealtimeActiveVisitors({
        env: c.env,
        siteId: input.siteId,
        startMs: input.startMs,
        endExclusiveMs: input.endExclusiveMs,
        signal: input.signal,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/realtime/events", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteRealtimeEvents(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteRealtimeEvents({
        env: c.env,
        siteId: input.siteId,
        startMs: input.startMs,
        endExclusiveMs: input.endExclusiveMs,
        limit: input.limit,
        signal: input.signal,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/realtime/sessions", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteRealtimeSessions(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteRealtimeSessions({
        env: c.env,
        siteId: input.siteId,
        startMs: input.startMs,
        endExclusiveMs: input.endExclusiveMs,
        limit: input.limit,
        signal: input.signal,
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/visitors/detail", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteVisitorDetail(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteVisitorDetail({
        env: c.env,
        siteId: input.siteId,
        visitorId: input.visitorId,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/sessions/detail", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteSessionDetail(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteSessionDetail({
        env: c.env,
        siteId: input.siteId,
        sessionId: input.sessionId,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
});
v1Routes.post("/sites/:siteId/analytics/visitors/search", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteVisitorsSearch(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteVisitors({
        env: c.env,
        siteId: input.siteId,
        search: input.search,
        sort: input.sort,
        page: input.page,
        filters: input.filters,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/sessions/search", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteSessionsSearch(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteSessions({
        env: c.env,
        siteId: input.siteId,
        search: input.search,
        sort: input.sort,
        page: input.page,
        filters: input.filters,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/visitors/events", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteVisitorEvents(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteVisitorEvents({
        env: c.env,
        siteId: input.siteId,
        visitorId: input.visitorId,
        limit: input.limit,
        page: { limit: input.limit },
        filters: input.filters,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/visitors/sessions", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteVisitorSessions(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteVisitorSessions({
        env: c.env,
        siteId: input.siteId,
        visitorId: input.visitorId,
        limit: input.limit,
        page: { limit: input.limit },
        filters: input.filters,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.post("/sites/:siteId/analytics/sessions/events", (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handlePlannedSiteSessionEvents(
    c.req.raw,
    principal(c),
    siteId,
    (input) =>
      readSiteSessionEvents({
        env: c.env,
        siteId: input.siteId,
        sessionId: input.sessionId,
        limit: input.limit,
        page: { limit: input.limit },
        filters: input.filters,
        window: {
          startMs: input.startMs,
          endExclusiveMs: input.endExclusiveMs,
          timeZone: input.timeZone,
          nowMs: Date.now(),
        },
      }),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    createAnalysisDefinitionReader(c.env, principal(c)),
  );
});
v1Routes.all("/sites", (c) =>
  handlePlannedResourceRoute({
    request: c.req.raw,
    env: c.env,
    principal: principal(c),
    routeId: c.req.method === "POST" ? "sites.create" : "sites.list",
    allow: "GET, POST",
  }),
);
v1Routes.all("/sites/:siteId", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId:
        c.req.method === "PATCH"
          ? "sites.update"
          : c.req.method === "DELETE"
            ? "sites.delete"
            : "sites.get",
      allow: "GET, PATCH, DELETE",
    }),
  ),
);
v1Routes.all("/sites/:siteId/settings/tracking", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId:
        c.req.method === "PATCH"
          ? "settings.tracking.update"
          : "settings.tracking.get",
      allow: "GET, PATCH",
    }),
  ),
);
v1Routes.all("/sites/:siteId/settings/privacy", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId:
        c.req.method === "PATCH"
          ? "settings.privacy.update"
          : "settings.privacy.get",
      allow: "GET, PATCH",
    }),
  ),
);
v1Routes.all("/sites/:siteId/settings/sharing", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId:
        c.req.method === "PATCH"
          ? "settings.sharing.update"
          : "settings.sharing.get",
      allow: "GET, PATCH",
    }),
  ),
);
v1Routes.all("/sites/:siteId/settings/tracking-script", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId: "settings.trackingScript.get",
      allow: "GET",
    }),
  ),
);
v1Routes.all("/sites/:siteId/funnels", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      routeId: c.req.method === "POST" ? "funnels.create" : "funnels.list",
      allow: "GET, POST",
    }),
  ),
);
v1Routes.all("/sites/:siteId/funnels/:funnelId", (c) =>
  withSiteId(c, (siteId) =>
    handlePlannedResourceRoute({
      request: c.req.raw,
      env: c.env,
      principal: principal(c),
      siteId,
      funnelId: c.req.param("funnelId"),
      routeId:
        c.req.method === "PATCH"
          ? "funnels.update"
          : c.req.method === "DELETE"
            ? "funnels.delete"
            : "funnels.get",
      allow: "GET, PATCH, DELETE",
    }),
  ),
);
v1Routes.all("/*", resourceNotFound);
