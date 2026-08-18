import { type Context, Hono } from "hono";

import { resolvePrivateSiteForSession } from "@/lib/edge/query/core";
import { handleSavedFilters } from "@/lib/edge/saved-filters";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export const privateSavedFilterRoutes = new Hono<AppEnv>();

async function savedFiltersRoute(c: Context<AppEnv>) {
  const session = c.get("session");
  if (!session) throw new Error("private session context missing");
  const site = await resolvePrivateSiteForSession(
    c.req.raw,
    c.env,
    requestUrl(c),
    session,
  );
  if (site instanceof Response) return site;
  return handleSavedFilters(c.req.raw, c.env, {
    siteId: site.id,
    session,
    filterId: c.req.param("filterId") || undefined,
  });
}

privateSavedFilterRoutes.all("/", savedFiltersRoute);
privateSavedFilterRoutes.all("/:filterId", savedFiltersRoute);
