import type { MiddlewareHandler } from "hono";

import {
  type DashboardCacheOptions,
  withDashboardCache,
} from "@/lib/edge/dashboard-cache";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext, requestUrl } from "@/lib/hono/utils/context";

export function dashboardCacheMiddleware(
  options?: DashboardCacheOptions,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const response = await withDashboardCache(
      executionContext(c),
      requestUrl(c),
      async () => {
        await next();
        return c.res;
      },
      options,
    );
    c.res = response;
    return response;
  };
}
