import type { MiddlewareHandler } from "hono";

import { methodNotAllowed } from "@/lib/edge/api-v1-helpers";
import type { AppEnv } from "@/lib/hono/types";

export function requireMethodMiddleware(
  method: string,
): MiddlewareHandler<AppEnv> {
  const allowed = method.toUpperCase();
  return async (c, next) => {
    if (c.req.raw.method.toUpperCase() !== allowed) {
      const response = methodNotAllowed(c.req.raw);
      c.res = response;
      return response;
    }
    await next();
  };
}

export function requireMethodsMiddleware(
  methods: readonly string[],
): MiddlewareHandler<AppEnv> {
  const allowed = new Set(methods.map((method) => method.toUpperCase()));
  return async (c, next) => {
    if (!allowed.has(c.req.raw.method.toUpperCase())) {
      const response = methodNotAllowed(c.req.raw);
      c.res = response;
      return response;
    }
    await next();
  };
}
