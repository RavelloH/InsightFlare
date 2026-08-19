import type { MiddlewareHandler } from "hono";

import { resolveDashboardSession } from "@/lib/edge/query-runtime/team-dashboard";
import type { AppEnv } from "@/lib/hono/types";
import { una as unauthorized } from "@/lib/response";

export function requireSessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await resolveDashboardSession(c.req.raw, c.env);
    if (!session) {
      const response = unauthorized("Unauthorized", undefined, c.req.raw);
      c.res = response;
      return response;
    }
    c.set("session", session);
    await next();
  };
}
