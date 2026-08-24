import "@tanstack/react-start/server-only";

import type {
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { resolvePrivateTeamForSession } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryTeamDashboardForTeam,
  type TeamDashboardQueryResult,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import { requireSession } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export interface TeamDashboardScope {
  readonly session: EdgeSessionClaims;
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
}

export interface ResolveTeamDashboardScopeInput {
  readonly request: Request;
  readonly env: Env;
  readonly teamId: string;
  readonly session?: EdgeSessionClaims;
}

export interface ReadTeamDashboardInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly interval: Interval;
  readonly allowedSiteIds?: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
}

/**
 * Resolves a dashboard session for the active build target. Demo credentials
 * never reach the production session verifier.
 */
export async function resolveDashboardSession(
  request: Request,
  env: Env,
): Promise<EdgeSessionClaims | null> {
  if (isDemoBuild) {
    const { resolveDemoDashboardSession } =
      await import("../../mock/team-dashboard-demo");
    return resolveDemoDashboardSession(request);
  }
  return requireSession(request, env);
}

/** Resolves team ACLs through the same runtime selected for data reads. */
export async function resolveTeamDashboardScope(
  input: ResolveTeamDashboardScopeInput,
): Promise<TeamDashboardScope | Response> {
  if (isDemoBuild) {
    const { resolveDemoTeamDashboardScope } =
      await import("../../mock/team-dashboard-demo");
    return resolveDemoTeamDashboardScope(input);
  }

  const session =
    input.session ?? (await resolveDashboardSession(input.request, input.env));
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(input.request.url);
  url.searchParams.set("teamId", input.teamId);
  const team = await resolvePrivateTeamForSession(
    input.request,
    input.env,
    url,
    session,
  );
  if (team instanceof Response) return team;

  return {
    session,
    teamId: team.id,
    allowedSiteIds: team.allowedSiteIds,
  };
}

/**
 * Reads the team dashboard through the selected typed reader. Both readers
 * return the same contract consumed by API routes and server loaders.
 */
export async function readTeamDashboard(
  input: ReadTeamDashboardInput,
): Promise<TeamDashboardQueryResult> {
  if (isDemoBuild) {
    const { readDemoTeamDashboard } =
      await import("../../mock/team-dashboard-demo");
    return readDemoTeamDashboard(input);
  }
  return queryTeamDashboardForTeam(
    input.env,
    input.teamId,
    input.window,
    input.interval,
    input.allowedSiteIds ? [...input.allowedSiteIds] : undefined,
    input.diagnostics,
  );
}
