import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";

import type { AppEnv } from "@/lib/hono/types";
import { internalServerError } from "@/lib/hono/utils/response";

export function handleHonoError(error: Error, c: Context<AppEnv>): Response {
  console.error("hono_route_unhandled_error", {
    method: c.req.raw.method,
    url: c.req.raw.url,
    error,
  });
  return internalServerError(c.req.raw, error);
}

export function errorBoundaryMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof Response) {
        c.res = error;
        return error;
      }
      const response = handleHonoError(
        error instanceof Error ? error : new Error(String(error)),
        c,
      );
      c.res = response;
      return response;
    }
  };
}
