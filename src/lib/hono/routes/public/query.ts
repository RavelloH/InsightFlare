import type { Context } from "hono";
import { Hono } from "hono";

import { executePublicQuery } from "@/lib/edge/analytics/adapters/public";
import {
  jsonResponse,
  PUBLIC_QUERY_PATHS,
} from "@/lib/edge/analytics/composition/d1-contract-adapters";
import { PUBLIC_QUERY_CACHE_OPTIONS } from "@/lib/edge/dashboard-cache";
import { dashboardCacheMiddleware } from "@/lib/hono/middleware/dashboard-cache";
import { requireMethodMiddleware } from "@/lib/hono/middleware/method";
import { resolvePublicSiteMiddleware } from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

function publicSlug(c: Context<AppEnv>): string {
  return c.req.param("slug") || "";
}

function publicQuery(pathname: string) {
  return (c: Context<AppEnv>) => {
    const site = c.get("publicSite");
    if (!site) {
      throw new Error("public site context missing");
    }
    return executePublicQuery({
      env: c.env,
      siteId: site.id,
      pathname,
      url: requestUrl(c),
      request: c.req.raw,
    });
  };
}

export const publicQueryRoutes = new Hono<AppEnv>();

publicQueryRoutes.use("/:slug/*", requireMethodMiddleware("GET"));

publicQueryRoutes.get(
  "/:slug/site",
  resolvePublicSiteMiddleware(),
  dashboardCacheMiddleware(PUBLIC_QUERY_CACHE_OPTIONS),
  (c) => {
    const site = c.get("publicSite");
    if (!site) {
      throw new Error("public site context missing");
    }
    return jsonResponse({
      ok: true,
      data: {
        slug: publicSlug(c),
        name: site.name,
        domain: site.domain,
        id: site.id,
      },
    });
  },
);

for (const path of PUBLIC_QUERY_PATHS) {
  publicQueryRoutes.get(
    `/:slug/${path}`,
    resolvePublicSiteMiddleware(),
    dashboardCacheMiddleware(PUBLIC_QUERY_CACHE_OPTIONS),
    publicQuery(path),
  );
}

publicQueryRoutes.all(
  "/:slug/*",
  resolvePublicSiteMiddleware(),
  dashboardCacheMiddleware(PUBLIC_QUERY_CACHE_OPTIONS),
  (c) => {
    const segments = requestUrl(c).pathname.split("/").filter(Boolean);
    const shareIndex = segments.indexOf("share");
    const pathname =
      shareIndex >= 0
        ? segments.slice(shareIndex + 2).join("/")
        : segments.slice(2).join("/");
    return publicQuery(pathname)(c);
  },
);
