import type { Context } from "hono";
import { Hono } from "hono";

import { notAllowed } from "@/lib/edge/query/core";
import {
  DASHBOARD_QUERY_PATHS,
  dispatchQueryRoute,
} from "@/lib/edge/query/router";
import { handleTeamDashboard } from "@/lib/edge/query/team";
import { dashboardCacheMiddleware } from "@/lib/hono/middleware/dashboard-cache";
import {
  requireMethodMiddleware,
  requireMethodsMiddleware,
} from "@/lib/hono/middleware/method";
import { resolvePrivateSiteMiddleware } from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

const FUNNEL_PATH = "funnels";
const TEAM_DASHBOARD_PATH = "team-dashboard";

function privateQuery(pathname: string) {
  return (c: Context<AppEnv>) => {
    const site = c.get("privateSite");
    if (!site) {
      throw new Error("private site context missing");
    }
    return dispatchQueryRoute(
      c.env,
      site.id,
      pathname,
      requestUrl(c),
      { publicMode: false },
      c.req.raw,
    );
  };
}

export const privateQueryRoutes = new Hono<AppEnv>();

privateQueryRoutes.all("/team-dashboard", (c) => {
  if (c.req.raw.method !== "GET") return notAllowed();
  return handleTeamDashboard(c.req.raw, c.env, requestUrl(c));
});

privateQueryRoutes.use(
  `/${FUNNEL_PATH}`,
  requireMethodsMiddleware(["GET", "POST", "DELETE"]),
);
privateQueryRoutes.all(
  `/${FUNNEL_PATH}`,
  resolvePrivateSiteMiddleware(),
  privateQuery(FUNNEL_PATH),
);

for (const path of DASHBOARD_QUERY_PATHS) {
  if (path === FUNNEL_PATH || path === TEAM_DASHBOARD_PATH) continue;
  privateQueryRoutes.use(`/${path}`, requireMethodMiddleware("GET"));
  privateQueryRoutes.all(
    `/${path}`,
    resolvePrivateSiteMiddleware(),
    dashboardCacheMiddleware(),
    privateQuery(path),
  );
}

privateQueryRoutes.use("/*", requireMethodMiddleware("GET"));
privateQueryRoutes.all(
  "/*",
  resolvePrivateSiteMiddleware(),
  dashboardCacheMiddleware(),
  (c) => {
    const pathname = requestUrl(c).pathname.replace(/^\/api\/private\//, "");
    return privateQuery(pathname)(c);
  },
);
