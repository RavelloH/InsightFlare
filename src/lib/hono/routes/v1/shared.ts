import type { Context } from "hono";

import { jsonError } from "@/lib/api-v1/wire-helpers";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

export function principal(c: Context<AppEnv>): ApiKeyPrincipal {
  const value = c.get("apiPrincipal");
  if (!value) {
    throw new Error("api principal context missing");
  }
  return value;
}

export function resourceNotFound(c: Context<AppEnv>): Response {
  return jsonError(
    "resource_not_found",
    "Resource not found",
    404,
    undefined,
    c.req.raw,
  );
}

export function withSiteId(
  c: Context<AppEnv>,
  handler: (siteId: string) => Promise<Response>,
): Promise<Response> | Response {
  const siteId = c.req.param("siteId");
  if (!siteId) return resourceNotFound(c);
  return handler(siteId);
}
