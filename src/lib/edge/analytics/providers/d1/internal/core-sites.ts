import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/member-site-access";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

import { normalizeFilterValue } from "./core-parsers";
import { badRequest, notFound, unauthorized } from "./core-responses";
import { type SiteRow } from "./core-types";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

async function demoSiteById(siteId: string): Promise<SiteRow | null> {
  const { DEMO_SITE_PROFILES } =
    await import("@/lib/realtime/demo-site-profiles");
  const profile = DEMO_SITE_PROFILES.find(
    (candidate) => candidate.id === siteId,
  );
  return profile
    ? { id: profile.id, name: profile.name, domain: profile.domain }
    : null;
}

async function demoSiteByPublicSlug(slug: string): Promise<SiteRow | null> {
  try {
    const { findSiteProfileByPublicSlug } =
      await import("@/lib/realtime/demo-site-profiles");
    const profile = findSiteProfileByPublicSlug(slug);
    return profile
      ? { id: profile.id, name: profile.name, domain: profile.domain }
      : null;
  } catch {
    return null;
  }
}

export async function resolvePrivateSite(
  request: Request,
  env: Env,
  url: URL,
): Promise<SiteRow | Response> {
  const session = await requireSession(request, env);
  if (!session) return unauthorized("Unauthorized", undefined, request);

  return resolvePrivateSiteForSession(request, env, url, session);
}

export async function resolvePrivateSiteForSession(
  request: Request,
  env: Env,
  url: URL,
  session: EdgeSessionClaims,
): Promise<SiteRow | Response> {
  const siteId = normalizeFilterValue(url.searchParams.get("siteId"));
  if (!siteId) return badRequest("siteId is required", undefined, request);

  if (isDemoBuild) {
    const site = await demoSiteById(siteId);
    return site ?? notFound("Site not found", undefined, request);
  }

  if (session.systemRole === "admin") {
    const site = await env.DB.prepare(
      "SELECT id,name,domain FROM sites WHERE id=? LIMIT 1",
    )
      .bind(siteId)
      .first<SiteRow>();
    return site ?? notFound("Site not found", undefined, request);
  }

  const site = await env.DB.prepare(
    `
      SELECT
        s.id,
        s.name,
        s.domain,
        t.owner_user_id AS ownerUserId,
        tm.role,
        tm.site_ids_json AS siteIdsJson
      FROM sites s
      INNER JOIN teams t ON t.id = s.team_id
      LEFT JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = ?
      WHERE s.id = ?
      LIMIT 1
    `,
  )
    .bind(session.userId, siteId)
    .first<
      SiteRow & {
        ownerUserId: string;
        role: string | null;
        siteIdsJson: string | null;
      }
    >();
  if (!site) return notFound("Site not found", undefined, request);
  if (site.ownerUserId === session.userId) return site;
  if (site.role === "owner" || site.role === "admin") return site;
  if (
    site.role &&
    canAccessMemberSite(parseMemberSiteIdsJson(site.siteIdsJson), siteId)
  ) {
    return site;
  }
  return notFound("Site not found", undefined, request);
}

export async function resolvePrivateTeam(
  request: Request,
  env: Env,
  url: URL,
): Promise<{ id: string; allowedSiteIds?: string[] } | Response> {
  const session = await requireSession(request, env);
  if (!session) return unauthorized("Unauthorized", undefined, request);

  return resolvePrivateTeamForSession(request, env, url, session);
}

export async function resolvePrivateTeamForSession(
  request: Request,
  env: Env,
  url: URL,
  session: EdgeSessionClaims,
): Promise<{ id: string; allowedSiteIds?: string[] } | Response> {
  const teamId = normalizeFilterValue(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("teamId is required", undefined, request);

  if (session.systemRole === "admin") {
    const team = await env.DB.prepare("SELECT id FROM teams WHERE id=? LIMIT 1")
      .bind(teamId)
      .first<{ id: string }>();
    return team ?? notFound("Team not found", undefined, request);
  }

  const team = await env.DB.prepare(
    `
      SELECT
        t.id,
        t.owner_user_id AS ownerUserId,
        tm.role,
        tm.site_ids_json AS siteIdsJson
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      WHERE t.id = ?
      LIMIT 1
    `,
  )
    .bind(session.userId, teamId)
    .first<{
      id: string;
      ownerUserId: string;
      role: string | null;
      siteIdsJson: string | null;
    }>();
  if (!team) return notFound("Team not found", undefined, request);
  if (team.ownerUserId === session.userId) return { id: team.id };
  if (team.role === "owner" || team.role === "admin") return { id: team.id };
  if (!team.role) return notFound("Team not found", undefined, request);
  return {
    id: team.id,
    allowedSiteIds: parseMemberSiteIdsJson(team.siteIdsJson),
  };
}

export async function fetchPublicSite(
  env: Env,
  url: URL,
): Promise<SiteRow | Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  let slug = "";
  try {
    const shareIndex = segments.indexOf("share");
    const slugSegment =
      shareIndex >= 0 ? segments[shareIndex + 1] : segments[2];
    slug = decodeURIComponent(slugSegment || "").trim();
  } catch {
    return notFound("Public site not found");
  }
  if (!slug) return notFound("Public site not found");

  if (isDemoBuild) {
    const site = await demoSiteByPublicSlug(slug);
    return site ?? notFound("Public site not found");
  }

  const site = await env.DB.prepare(
    "SELECT id,name,domain FROM sites WHERE public_enabled=1 AND public_slug=? LIMIT 1",
  )
    .bind(slug)
    .first<SiteRow>();
  return site ?? notFound("Public site not found");
}
