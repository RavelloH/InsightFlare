import "@tanstack/react-start/server-only";

import { resolveTeamDashboardScope } from "@/lib/edge/query-runtime/team-dashboard";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

import { readReportingTimeZoneFromCookie } from "./query-preferences";

export interface ResolvedTeamDashboardRequest {
  readonly env: Env;
  readonly request: Request;
  readonly session: EdgeSessionClaims;
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly timeZone: string;
}

export type TeamDashboardRequestResolution =
  | ResolvedTeamDashboardRequest
  | Response;

/** Resolves authenticated SSR inputs without bypassing existing team ACLs. */
export async function resolveTeamDashboardRequest(input: {
  request: Request;
  env: Env;
  teamId: string;
}): Promise<TeamDashboardRequestResolution> {
  const team = await resolveTeamDashboardScope(input);
  if (team instanceof Response) return team;

  return {
    env: input.env,
    request: input.request,
    session: team.session,
    teamId: team.teamId,
    allowedSiteIds: team.allowedSiteIds,
    timeZone: readReportingTimeZoneFromCookie(
      input.request.headers.get("cookie"),
    ),
  };
}
