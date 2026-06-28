import type { Context } from "hono";
import { Hono } from "hono";

import { handleApiV1 } from "@/lib/edge/api-v1";
import type { AppEnv } from "@/lib/hono/types";

function handleV1(c: Context<AppEnv>) {
  return handleApiV1(
    c.req.raw,
    c.env,
    new URL(c.req.raw.url),
    c.executionCtx as unknown as ExecutionContext,
  );
}

export const v1Routes = new Hono<AppEnv>();

v1Routes.all("/", handleV1);
v1Routes.all("/token", handleV1);
v1Routes.all("/token/check", handleV1);
v1Routes.all("/capabilities", handleV1);
v1Routes.all("/team", handleV1);
v1Routes.all("/team/*", handleV1);
v1Routes.all("/sites", handleV1);
v1Routes.all("/sites/:siteId", handleV1);
v1Routes.all("/sites/:siteId/tracking", handleV1);
v1Routes.all("/sites/:siteId/privacy", handleV1);
v1Routes.all("/sites/:siteId/sharing", handleV1);
v1Routes.all("/sites/:siteId/analytics/*", handleV1);
v1Routes.all("/sites/:siteId/events", handleV1);
v1Routes.all("/sites/:siteId/events/*", handleV1);
v1Routes.all("/sites/:siteId/visitors", handleV1);
v1Routes.all("/sites/:siteId/visitors/:visitorId", handleV1);
v1Routes.all("/sites/:siteId/sessions", handleV1);
v1Routes.all("/sites/:siteId/sessions/:sessionId", handleV1);
v1Routes.all("/sites/:siteId/funnels", handleV1);
v1Routes.all("/sites/:siteId/funnels/:funnelId", handleV1);
v1Routes.all("/sites/:siteId/performance", handleV1);
v1Routes.all("/sites/:siteId/realtime", handleV1);
v1Routes.all("/batch", handleV1);
v1Routes.all("/*", handleV1);
