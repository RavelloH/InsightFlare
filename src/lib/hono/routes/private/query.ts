import type { Context } from "hono";
import { Hono } from "hono";

import { withDashboardCache } from "@/lib/edge/dashboard-cache";
import {
  badRequest,
  notAllowed,
  parseWindow,
  resolvePrivateTeamForSession,
} from "@/lib/edge/query/core";
import {
  DASHBOARD_QUERY_PATHS,
  dispatchQueryRoute,
} from "@/lib/edge/query/router";
import { handleTeamDashboardForTeam } from "@/lib/edge/query/team";
import { dashboardCacheMiddleware } from "@/lib/hono/middleware/dashboard-cache";
import {
  requireMethodMiddleware,
  requireMethodsMiddleware,
} from "@/lib/hono/middleware/method";
import { resolvePrivateSiteMiddleware } from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext, requestUrl } from "@/lib/hono/utils/context";

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
      // Private query routes are the dashboard API. This opt-in permits the
      // dashboard-only response shaping used by event detail while v1/public
      // callers retain the complete compatibility response.
      { publicMode: false, dashboardMode: true },
      c.req.raw,
    );
  };
}

export const privateQueryRoutes = new Hono<AppEnv>();

privateQueryRoutes.all("/team-dashboard", async (c) => {
  if (c.req.raw.method !== "GET") return notAllowed();
  const session = c.get("session");
  if (!session) {
    throw new Error("private session context missing");
  }
  const url = requestUrl(c);
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const team = await resolvePrivateTeamForSession(
    c.req.raw,
    c.env,
    url,
    session,
  );
  if (team instanceof Response) return team;

  return withDashboardCache(
    executionContext(c),
    url,
    () =>
      handleTeamDashboardForTeam(
        c.env,
        url,
        team.id,
        window,
        team.allowedSiteIds,
      ),
    {
      identity: {
        scope: "private-team",
        tenantId: team.id,
        route: "team-dashboard",
        audienceId: session.userId,
      },
      request: c.req.raw,
    },
  );
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
