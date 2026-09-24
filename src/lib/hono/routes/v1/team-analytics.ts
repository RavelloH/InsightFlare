import type { Context } from "hono";
import type { Hono } from "hono";

import {
  handlePlannedTeamAnalyticsSchema,
  handlePlannedTeamOverview,
  handlePlannedTeamSites,
  handlePlannedTeamTimeseries,
  handleTeamBreakdown,
  handleTeamComparison,
  handleTeamComparisonBreakdown,
} from "@/lib/api-v1";
import { createEdgeTeamAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";
interface TeamAnalyticsRouteDependencies {
  readonly resolvePrincipal: (c: Context<AppEnv>) => ApiKeyPrincipal;
  readonly resourceNotFound: (c: Context<AppEnv>) => Response;
}
function analyticsRuntime(c: Context<AppEnv>, principal: ApiKeyPrincipal) {
  return createEdgeTeamAnalyticsRuntime({
    env: c.env,
    teamId: principal.teamId,
    allowedSiteIds: [...principal.siteIds].sort(),
  });
}
function typedTeamOverview(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  const principal = deps.resolvePrincipal(c);
  return handlePlannedTeamOverview(
    c.req.raw,
    principal,
    analyticsRuntime(c, principal),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}
function typedTeamTimeseries(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  const principal = deps.resolvePrincipal(c);
  return handlePlannedTeamTimeseries(
    c.req.raw,
    principal,
    analyticsRuntime(c, principal),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}
function typedTeamSites(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  const principal = deps.resolvePrincipal(c);
  return handlePlannedTeamSites(
    c.req.raw,
    principal,
    analyticsRuntime(c, principal),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}
function typedTeamBreakdown(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  const dimension = c.req.param("dimension");
  if (!dimension) return Promise.resolve(deps.resourceNotFound(c));
  const principal = deps.resolvePrincipal(c);
  return handleTeamBreakdown(
    c.req.raw,
    principal,
    dimension,
    analyticsRuntime(c, principal),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}
export function registerV1TeamAnalyticsRoutes(
  routes: Hono<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): void {
  routes.post("/team/analytics/breakdowns/:dimension", (c) =>
    typedTeamBreakdown(c, deps),
  );
  routes.post("/team/analytics/comparison", (c) => {
    const principal = deps.resolvePrincipal(c);
    return handleTeamComparison(
      c.req.raw,
      principal,
      analyticsRuntime(c, principal),
    );
  });
  routes.post("/team/analytics/comparison/breakdowns/:dimension", (c) => {
    const dimension = c.req.param("dimension");
    if (!dimension) return deps.resourceNotFound(c);
    const principal = deps.resolvePrincipal(c);
    return handleTeamComparisonBreakdown(
      c.req.raw,
      principal,
      analyticsRuntime(c, principal),
      dimension,
    );
  });
  routes.post("/team/analytics/overview", (c) => typedTeamOverview(c, deps));
  routes.post("/team/analytics/timeseries", (c) =>
    typedTeamTimeseries(c, deps),
  );
  routes.post("/team/analytics/sites", (c) => typedTeamSites(c, deps));
  routes.all("/team/analytics/schema", (c) =>
    handlePlannedTeamAnalyticsSchema(c.req.raw, deps.resolvePrincipal(c)),
  );
}
