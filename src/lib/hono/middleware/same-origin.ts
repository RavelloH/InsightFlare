import type { MiddlewareHandler } from "hono";

import { requireSameOrigin } from "@/lib/edge/utils";
import type { AppEnv } from "@/lib/hono/types";

export function sameOriginMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const error = requireSameOrigin(c.req.raw);
    if (error) {
      c.res = error;
      return error;
    }
    await next();
  };
}
