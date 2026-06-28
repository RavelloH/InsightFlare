import type { Context } from "hono";
import { Hono } from "hono";

import {
  apiV1Segments,
  handleAnalytics,
  handleBatch,
  handleCapabilities,
  handleEvents,
  handleFunnels,
  handleJourneys,
  handlePerformance,
  handlePrivacy,
  handleRealtime,
  handleRoot,
  handleSharing,
  handleSiteResource,
  handleSitesCollection,
  handleTeam,
  handleToken,
  handleTokenCheck,
  handleTracking,
  handleTrackingScript,
} from "@/lib/edge/api-v1";
import { jsonError } from "@/lib/edge/api-v1-helpers";
import { authenticateApiKeyMiddleware } from "@/lib/hono/middleware/api-key";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext, requestUrl } from "@/lib/hono/utils/context";

function principal(c: Context<AppEnv>) {
  const value = c.get("apiPrincipal");
  if (!value) {
    throw new Error("api principal context missing");
  }
  return value;
}

function path(c: Context<AppEnv>): string[] {
  return apiV1Segments(requestUrl(c));
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
  handler: (siteId: string, routePath: string[]) => Promise<Response>,
) {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handler(siteId, path(c));
}

function mountedV1Request(request: Request, url: URL): Request {
  const mountedUrl = new URL(url);
  mountedUrl.pathname = mountedUrl.pathname.replace(/^\/api\/v1\/?/, "/");
  if (!mountedUrl.pathname.startsWith("/")) {
    mountedUrl.pathname = `/${mountedUrl.pathname}`;
  }
  return new Request(mountedUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
}

async function dispatchBatchSubrequest(
  request: Request,
  env: AppEnv["Bindings"],
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  return v1Routes.fetch(mountedV1Request(request, url), env, ctx);
}

export const v1Routes = new Hono<AppEnv>();

v1Routes.get("/", (c) => handleRoot(c.req.raw));
v1Routes.use("/*", authenticateApiKeyMiddleware());

v1Routes.all("/token", (c) => handleToken(c.req.raw, c.env, principal(c)));
v1Routes.all("/token/check", (c) => handleTokenCheck(c.req.raw, principal(c)));
v1Routes.all("/capabilities", (c) =>
  handleCapabilities(c.req.raw, principal(c)),
);
v1Routes.all("/team", (c) =>
  handleTeam(c.req.raw, c.env, requestUrl(c), principal(c), path(c)),
);
v1Routes.all("/team/*", (c) =>
  handleTeam(c.req.raw, c.env, requestUrl(c), principal(c), path(c)),
);
v1Routes.all("/batch", (c) =>
  handleBatch(
    c.req.raw,
    c.env,
    requestUrl(c),
    principal(c),
    (request, env, url) =>
      dispatchBatchSubrequest(request, env, url, executionContext(c)),
  ),
);
v1Routes.all("/sites", (c) =>
  handleSitesCollection(c.req.raw, c.env, principal(c)),
);
v1Routes.all("/sites/:siteId", (c) =>
  withSiteId(c, (siteId) =>
    handleSiteResource(c.req.raw, c.env, principal(c), siteId),
  ),
);
v1Routes.all("/sites/:siteId/tracking", (c) =>
  withSiteId(c, (siteId) =>
    handleTracking(c.req.raw, c.env, principal(c), siteId),
  ),
);
v1Routes.all("/sites/:siteId/tracking/script", (c) =>
  withSiteId(c, (siteId) =>
    handleTrackingScript(c.req.raw, c.env, requestUrl(c), principal(c), siteId),
  ),
);
v1Routes.all("/sites/:siteId/privacy", (c) =>
  withSiteId(c, (siteId) =>
    handlePrivacy(c.req.raw, c.env, principal(c), siteId),
  ),
);
v1Routes.all("/sites/:siteId/sharing", (c) =>
  withSiteId(c, (siteId) =>
    handleSharing(c.req.raw, c.env, principal(c), siteId),
  ),
);
v1Routes.all("/sites/:siteId/analytics/*", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleAnalytics(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/event-types", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleEvents(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/events", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleEvents(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/events/*", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleEvents(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/event-fields", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleEvents(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/visitors", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleJourneys(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/visitors/:visitorId", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleJourneys(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/sessions", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleJourneys(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/sessions/:sessionId", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleJourneys(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/funnels", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleFunnels(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/funnels/*", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleFunnels(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/performance", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handlePerformance(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/performance/*", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handlePerformance(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/realtime", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleRealtime(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/sites/:siteId/realtime/*", (c) =>
  withSiteId(c, (siteId, routePath) =>
    handleRealtime(
      c.req.raw,
      c.env,
      requestUrl(c),
      principal(c),
      siteId,
      routePath,
    ),
  ),
);
v1Routes.all("/*", resourceNotFound);
