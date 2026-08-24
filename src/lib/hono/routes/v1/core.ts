import type { Context } from "hono";
import type { Hono } from "hono";

import { dispatchApiV1CoreRoute } from "@/lib/api-v1/core-dispatcher";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

type PrincipalResolver = (c: Context<AppEnv>) => ApiKeyPrincipal;

/** Registers API v1 discovery and team-core routes. */
export function registerV1CoreRoutes(
  routes: Hono<AppEnv>,
  resolvePrincipal: PrincipalResolver,
): void {
  routes.all("/token", (c) =>
    dispatchApiV1CoreRoute({
      routeId: "core.token.get",
      request: c.req.raw,
      env: c.env,
      principal: resolvePrincipal(c),
    }),
  );
  routes.all("/token/check", (c) =>
    dispatchApiV1CoreRoute({
      routeId: "core.token.check",
      request: c.req.raw,
      env: c.env,
      principal: resolvePrincipal(c),
    }),
  );
  routes.all("/capabilities", (c) =>
    dispatchApiV1CoreRoute({
      routeId: "core.capabilities",
      request: c.req.raw,
      env: c.env,
      principal: resolvePrincipal(c),
    }),
  );
  routes.all("/team", (c) =>
    dispatchApiV1CoreRoute({
      routeId: "core.team.get",
      request: c.req.raw,
      env: c.env,
      principal: resolvePrincipal(c),
    }),
  );
  routes.all("/team/usage", (c) =>
    dispatchApiV1CoreRoute({
      routeId: "core.team.usage",
      request: c.req.raw,
      env: c.env,
      principal: resolvePrincipal(c),
    }),
  );
}
