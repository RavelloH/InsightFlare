import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "@/lib/hono/types";
import {
  cloneRequestWithJsonBody,
  readJsonRecord,
} from "@/lib/hono/utils/request";

export function normalizeJsonBodyMiddleware(
  transform: (body: Record<string, unknown>) => Record<string, unknown>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rawRequest = c.req.raw as unknown as Request;
    const body = await readJsonRecord(rawRequest.clone() as unknown as Request);
    if (body) {
      c.req.raw = cloneRequestWithJsonBody(
        rawRequest,
        transform(body),
      ) as typeof c.req.raw;
    }
    await next();
  };
}
