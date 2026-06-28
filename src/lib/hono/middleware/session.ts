import type { MiddlewareHandler } from "hono";

import { requireSession } from "@/lib/edge/session-auth";
import type { AppEnv } from "@/lib/hono/types";
import { una as unauthorized } from "@/lib/response";

export function requireSessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await requireSession(c.req.raw, c.env);
    if (!session) {
      const response = unauthorized("Unauthorized", undefined, c.req.raw);
      c.res = response;
      return response;
    }
    c.set("session", session);
    await next();
  };
}
