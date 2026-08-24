import type { Context } from "hono";
import type { Hono } from "hono";

import { handlePlannedTeamAnalyticsSchema } from "@/lib/api-v1/analytics-schema-handler";
import {
  handleTeamComparison,
  handleTeamComparisonBreakdown,
} from "@/lib/api-v1/comparison-handler";
import { handleTeamBreakdown } from "@/lib/api-v1/team-breakdown-handler";
import { handlePlannedTeamOverview } from "@/lib/api-v1/team-overview-handler";
import { handlePlannedTeamSites } from "@/lib/api-v1/team-sites-handler";
import { handlePlannedTeamTimeseries } from "@/lib/api-v1/team-timeseries-handler";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import { createApiV1ProviderRegistry } from "@/lib/edge/analytics/composition/api-v1-provider-registry";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

interface TeamAnalyticsRouteDependencies {
  readonly resolvePrincipal: (c: Context<AppEnv>) => ApiKeyPrincipal;
  readonly resourceNotFound: (c: Context<AppEnv>) => Response;
}

function providerRegistry(c: Context<AppEnv>, operation: AnalyticsOperationId) {
  return createApiV1ProviderRegistry({ env: c.env, operation });
}

function typedTeamOverview(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  return handlePlannedTeamOverview(
    c.req.raw,
    deps.resolvePrincipal(c),
    providerRegistry(c, "team.analytics.overview"),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamTimeseries(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  return handlePlannedTeamTimeseries(
    c.req.raw,
    deps.resolvePrincipal(c),
    providerRegistry(c, "team.analytics.timeseries"),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamSites(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  return handlePlannedTeamSites(
    c.req.raw,
    deps.resolvePrincipal(c),
    providerRegistry(c, "team.analytics.sites"),
    { signal: c.req.raw.signal, capturedAtMs: Date.now() },
  );
}

function typedTeamBreakdown(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  const dimension = c.req.param("dimension");
  if (!dimension) return Promise.resolve(deps.resourceNotFound(c));
  return handleTeamBreakdown(
    c.req.raw,
    deps.resolvePrincipal(c),
    dimension,
    providerRegistry(c, "team.analytics.breakdown"),
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
  routes.post("/team/analytics/comparison", (c) =>
    handleTeamComparison(c.req.raw, deps.resolvePrincipal(c), c.env),
  );
  routes.post("/team/analytics/comparison/breakdowns/:dimension", (c) => {
    const dimension = c.req.param("dimension");
    if (!dimension) return deps.resourceNotFound(c);
    return handleTeamComparisonBreakdown(
      c.req.raw,
      deps.resolvePrincipal(c),
      c.env,
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
