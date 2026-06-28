import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "@/lib/hono/types";
import { getRequestId } from "@/lib/response";

export function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = getRequestId(c.req.raw);
    c.set("requestId", requestId);
    await next();
  };
}
