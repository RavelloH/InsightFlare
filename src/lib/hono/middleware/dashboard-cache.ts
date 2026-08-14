import type { MiddlewareHandler } from "hono";

import {
  type DashboardCacheIdentity,
  type DashboardCacheOptions,
  withDashboardCache,
} from "@/lib/edge/dashboard-cache";
import { verifyDiagnosticCacheBypass } from "@/lib/edge/diagnostic-cache-bypass";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext, requestUrl } from "@/lib/hono/utils/context";

function cacheIdentity(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): DashboardCacheIdentity | undefined {
  const privateSite = c.get("privateSite");
  if (privateSite) {
    return {
      scope: "private",
      tenantId: privateSite.id,
      route: c.req.path.replace(/^\/api\/private\//, ""),
    };
  }

  const publicSite = c.get("publicSite");
  if (publicSite) {
    const segments = c.req.path.split("/").filter(Boolean);
    const shareIndex = segments.indexOf("share");
    return {
      scope: "public",
      tenantId: publicSite.id,
      route:
        shareIndex >= 0
          ? segments.slice(shareIndex + 2).join("/")
          : segments.slice(2).join("/"),
    };
  }

  return undefined;
}

export function dashboardCacheMiddleware(
  options?: DashboardCacheOptions,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const identity = cacheIdentity(c);
    const diagnosticBypass = await verifyDiagnosticCacheBypass({
      actorId: c.get("session")?.userId,
      env: c.env,
      request: c.req.raw,
    });
    const response = await withDashboardCache(
      executionContext(c),
      requestUrl(c),
      async () => {
        await next();
        return c.res;
      },
      identity
        ? {
            ...options,
            ...(options?.bypassCache === true || diagnosticBypass
              ? { bypassCache: true }
              : {}),
            identity,
            request: c.req.raw,
            cacheGeneration: c.env.DASHBOARD_CACHE_GENERATION,
          }
        : options,
    );
    c.res = response;
    return response;
  };
}
