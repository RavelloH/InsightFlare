import type { Context } from "hono";
import { Hono } from "hono";

import {
  executePrivateQuery,
  executePrivateTeamDashboard,
} from "@/lib/edge/analytics/adapters/private";
import {
  DASHBOARD_QUERY_PATHS,
  notAllowed,
} from "@/lib/edge/analytics/composition/d1-contract-adapters";
import { resolveTeamDashboardScope } from "@/lib/edge/analytics/composition/d1-provider";
import { withDashboardCache } from "@/lib/edge/dashboard-cache";
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
    return executePrivateQuery({
      env: c.env,
      siteId: site.id,
      pathname,
      url: requestUrl(c),
      request: c.req.raw,
      dashboardMode: true,
    });
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
  const team = await resolveTeamDashboardScope({
    request: c.req.raw,
    env: c.env,
    teamId: url.searchParams.get("teamId") || "",
    session,
  });
  if (team instanceof Response) return team;

  return withDashboardCache(
    executionContext(c),
    url,
    () =>
      executePrivateTeamDashboard({
        env: c.env,
        teamId: team.teamId,
        allowedSiteIds: team.allowedSiteIds,
        url,
      }),
    {
      identity: {
        scope: "private-team",
        tenantId: team.teamId,
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
