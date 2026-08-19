import "@tanstack/react-start/server-only";

import { resolvePrivateTeamForSession } from "@/lib/edge/query/core";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import { requireSession } from "@/lib/edge/session-auth";
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
  const session = await requireSession(input.request, input.env);
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
    env: input.env,
    request: input.request,
    session,
    teamId: team.id,
    allowedSiteIds: team.allowedSiteIds,
    timeZone: readReportingTimeZoneFromCookie(
      input.request.headers.get("cookie"),
    ),
  };
}
