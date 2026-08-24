import type { Context } from "hono";
import type { Hono } from "hono";

import { handlePlannedTeamAnalyticsSchema } from "@/lib/api-v1/analytics-schema-handler";
import {
  handleTeamComparison,
  handleTeamComparisonBreakdown,
} from "@/lib/api-v1/comparison-handler";
import {
  handleTeamBreakdown,
  type TeamBreakdownReader,
} from "@/lib/api-v1/team-breakdown-handler";
import {
  handlePlannedTeamOverview,
  type TeamOverviewReader,
} from "@/lib/api-v1/team-overview-handler";
import {
  handlePlannedTeamSites,
  type TeamSitesReader,
} from "@/lib/api-v1/team-sites-handler";
import {
  handlePlannedTeamTimeseries,
  type TeamTimeseriesReader,
} from "@/lib/api-v1/team-timeseries-handler";
import {
  readTeamBreakdown,
  readTeamOverview,
  readTeamSites,
  readTeamTimeseries,
} from "@/lib/edge/analytics/adapters/api-v1";
import { createReaderProviderRegistry } from "@/lib/edge/analytics/composition/create-provider-registry";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

interface TeamAnalyticsRouteDependencies {
  readonly resolvePrincipal: (c: Context<AppEnv>) => ApiKeyPrincipal;
  readonly resourceNotFound: (c: Context<AppEnv>) => Response;
}

function typedTeamOverview(
  c: Context<AppEnv>,
  deps: TeamAnalyticsRouteDependencies,
): Promise<Response> {
  return handlePlannedTeamOverview(
    c.req.raw,
    deps.resolvePrincipal(c),
    createReaderProviderRegistry<TeamOverviewReader>(
      "team.analytics.overview",
      (input) =>
        readTeamOverview({
          env: c.env,
          teamId: input.teamId,
          allowedSiteIds: input.allowedSiteIds,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
    ),
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
    createReaderProviderRegistry<TeamTimeseriesReader>(
      "team.analytics.timeseries",
      (input) =>
        readTeamTimeseries({
          env: c.env,
          teamId: input.teamId,
          allowedSiteIds: input.allowedSiteIds,
          interval: input.interval,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
    ),
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
    createReaderProviderRegistry<TeamSitesReader>(
      "team.analytics.sites",
      (input) =>
        readTeamSites({
          env: c.env,
          teamId: input.teamId,
          allowedSiteIds: input.allowedSiteIds,
          interval: input.interval,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
    ),
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
    createReaderProviderRegistry<TeamBreakdownReader>(
      "team.analytics.breakdown",
      (input) =>
        readTeamBreakdown({
          env: c.env,
          teamId: input.teamId,
          allowedSiteIds: input.allowedSiteIds,
          dimension: input.dimension,
          limit: input.limit,
          window: {
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            timeZone: input.timeZone,
            nowMs: Date.now(),
          },
          filters: input.filters,
        }),
    ),
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
