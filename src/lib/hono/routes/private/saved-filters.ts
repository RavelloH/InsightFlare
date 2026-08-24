import { type Context, Hono } from "hono";

import {
  getRequestId,
  resolvePrivateSiteForSession,
} from "@/lib/edge/analytics/composition/query-protocol";
import { handleSavedFilters } from "@/lib/edge/saved-filters";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

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
  if (isDemoBuild) {
    const { executeDemoQuery } =
      await import("@/lib/edge/analytics/composition/mock-provider");
    return executeDemoQuery({
      request: c.req.raw,
      url: requestUrl(c),
      siteId: site.id,
      context: { requestId: getRequestId(c.req.raw) },
    });
  }
  return handleSavedFilters(c.req.raw, c.env, {
    siteId: site.id,
    session,
    filterId: c.req.param("filterId") || undefined,
  });
}

privateSavedFilterRoutes.all("/", savedFiltersRoute);
privateSavedFilterRoutes.all("/:filterId", savedFiltersRoute);
