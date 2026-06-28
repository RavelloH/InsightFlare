import type { MiddlewareHandler } from "hono";

import { authenticateApiKey } from "@/lib/edge/api-key-auth";
import type { ApiKeyScope } from "@/lib/edge/api-key-store";
import { requireScope } from "@/lib/edge/api-v1-helpers";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext } from "@/lib/hono/utils/context";

export function authenticateApiKeyMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = await authenticateApiKey(
      c.req.raw,
      c.env,
      executionContext(c),
    );
    if (principal instanceof Response) {
      c.res = principal;
      return principal;
    }
    c.set("apiPrincipal", principal);
    await next();
  };
}

export function requireApiScopeMiddleware(
  scope: ApiKeyScope,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let principal = c.get("apiPrincipal");
    if (!principal) {
      const authenticated = await authenticateApiKey(
        c.req.raw,
        c.env,
        executionContext(c),
      );
      if (authenticated instanceof Response) {
        c.res = authenticated;
        return authenticated;
      }
      principal = authenticated;
      c.set("apiPrincipal", principal);
    }
    const denied = requireScope(principal.scopes, scope, c.req.raw);
    if (denied) {
      c.res = denied;
      return denied;
    }
    await next();
  };
}
