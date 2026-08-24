import { Hono } from "hono";

import { requireScope } from "@/lib/api-v1/auth-helpers";
import { dispatchApiV1CoreRoute } from "@/lib/api-v1/core-dispatcher";
import { TypedBatchRequestSchema } from "@/lib/api-v1/dto/batch";
import {
  API_V1_BATCH_BODY_MAX_BYTES,
  API_V1_BATCH_ITEM_BODY_MAX_BYTES,
  inspectJsonBudget,
  readBoundedBody,
  serializedUtf8ByteLength,
} from "@/lib/api-v1/request-budget";
import { handlePlannedResourceRoute } from "@/lib/api-v1/resource-handler";
import {
  executeTypedBatch,
  TypedBatchValidationError,
} from "@/lib/api-v1/typed-batch";
import { jsonError, jsonSuccess } from "@/lib/api-v1/wire-helpers";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { authenticateApiKeyMiddleware } from "@/lib/hono/middleware/api-key";
import { registerV1CoreRoutes } from "@/lib/hono/routes/v1/core";
import {
  principal,
  resourceNotFound,
  withSiteId,
} from "@/lib/hono/routes/v1/shared";
import { registerV1SiteAnalyticsRoutes } from "@/lib/hono/routes/v1/site-analytics";
import { registerV1TeamAnalyticsRoutes } from "@/lib/hono/routes/v1/team-analytics";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext } from "@/lib/hono/utils/context";

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

registerV1CoreRoutes(v1Routes, principal);
registerV1TeamAnalyticsRoutes(v1Routes, {
  resolvePrincipal: principal,
  resourceNotFound,
});
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
registerV1SiteAnalyticsRoutes(v1Routes, {
  resolvePrincipal: principal,
  resourceNotFound,
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
