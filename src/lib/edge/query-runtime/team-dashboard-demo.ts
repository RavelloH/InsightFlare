import "@tanstack/react-start/server-only";

import type { TeamDashboardQueryResult } from "@/lib/edge/query/team";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import {
  getDemoSites,
  getDemoTeams,
  getDemoUser,
} from "@/lib/realtime/mock/admin";
import { generateDemoTeamDashboard } from "@/lib/realtime/mock/team-dashboard";

import type {
  ReadTeamDashboardInput,
  ResolveTeamDashboardScopeInput,
  TeamDashboardScope,
} from "./team-dashboard";

type DemoTeamDashboardEnvelope = {
  readonly ok: boolean;
  readonly data?: TeamDashboardQueryResult["data"];
};

function demoSession(): EdgeSessionClaims {
  const user = getDemoUser();
  return {
    userId: user.id,
    username: user.username,
    displayName: user.name,
    systemRole: user.systemRole,
    // Demo sessions are build-scoped rather than credential-scoped.
    exp: Number.MAX_SAFE_INTEGER,
  };
}

export async function resolveDemoDashboardSession(
  _request: Request,
): Promise<EdgeSessionClaims> {
  return demoSession();
}

export async function resolveDemoTeamDashboardScope(
  input: ResolveTeamDashboardScopeInput,
): Promise<TeamDashboardScope | Response> {
  const session = input.session ?? demoSession();
  const team = getDemoTeams().find(
    (candidate) => candidate.id === input.teamId,
  );
  if (!team) return new Response("Not found", { status: 404 });

  return {
    session,
    teamId: team.id,
    allowedSiteIds: getDemoSites(team.id).map((site) => site.id),
  };
}

export async function readDemoTeamDashboard(
  input: ReadTeamDashboardInput,
): Promise<TeamDashboardQueryResult> {
  const generated = generateDemoTeamDashboard(input.teamId, {
    from: input.window.startMs,
    to: input.window.endExclusiveMs,
    interval: input.interval,
    timeZone: input.window.timeZone,
  }) as DemoTeamDashboardEnvelope;
  if (!generated.ok || !generated.data) {
    throw new Error("demo_team_dashboard_generation_failed");
  }

  const allowedSiteIds = input.allowedSiteIds
    ? new Set(input.allowedSiteIds)
    : null;
  const sites = allowedSiteIds
    ? generated.data.sites.filter((site) => allowedSiteIds.has(site.id))
    : generated.data.sites;

  return {
    data: {
      sites,
      trend: generated.data.trend.map((bucket) => ({
        ...bucket,
        sites: allowedSiteIds
          ? bucket.sites.filter((site) => allowedSiteIds.has(site.siteId))
          : bucket.sites,
      })),
    },
    source: "mock",
  };
}
