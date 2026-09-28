import {
  and,
  compileD1Query,
  createDatabaseClient,
  createDatabaseRuntime,
  eq,
  filter,
  join,
  limit,
  param,
  project,
  scan,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/auth/member-site-access";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
function normalizeFilterValue(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}
import {
  bad as badRequest,
  nf as notFound,
  una as unauthorized,
} from "@/lib/response";
export interface SiteAccessRecord {
  id: string;
  name: string;
  domain: string;
  canManage?: boolean;
}
type SiteRow = SiteAccessRecord;
const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

function database(env: Pick<Env, "DB">) {
  return createDatabaseClient(createDatabaseRuntime(env.DB));
}

function withSiteId<Row extends { id: string | null }>(row: Row | null) {
  if (!row || row.id === null) return null;
  return { ...row, id: row.id };
}
async function demoSiteById(siteId: string): Promise<SiteRow | null> {
  const { DEMO_SITE_PROFILES } = await import("@/lib/demo/data/site-profiles");
  const profile = DEMO_SITE_PROFILES.find(
    (candidate) => candidate.id === siteId,
  );
  return profile
    ? {
        id: profile.id,
        name: profile.name,
        domain: profile.domain,
        canManage: true,
      }
    : null;
}
async function demoSiteByPublicSlug(slug: string): Promise<SiteRow | null> {
  try {
    const { findSiteProfileByPublicSlug } =
      await import("@/lib/demo/data/site-profiles");
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
    return site
      ? { ...site, canManage: true }
      : notFound("Site not found", undefined, request);
  }

  const sites = scan(schema.sites);
  const matchingSites = filter(sites, eq(sites.columns.id, param(siteId)));
  if (session.systemRole === "admin") {
    const site = withSiteId(
      await database(env).first(
        compileD1Query(
          limit(
            project(matchingSites, {
              id: matchingSites.columns.id,
              name: matchingSites.columns.name,
              domain: matchingSites.columns.domain,
            }),
            1,
          ),
          { tag: "auth.sites.first" },
        ),
      ),
    );
    return site
      ? { ...site, canManage: true }
      : notFound("Site not found", undefined, request);
  }

  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const siteTeams = join(
    sites,
    teams,
    eq(sites.columns.team_id, teams.columns.id),
    "inner",
  );
  const siteTeamMembers = join(
    siteTeams,
    members,
    and(
      eq(siteTeams.columns.left_team_id, members.columns.team_id),
      eq(members.columns.user_id, param(session.userId)),
    ),
    "left",
  );
  const matchingPrivateSites = filter(
    siteTeamMembers,
    eq(siteTeamMembers.columns.left_left_id, param(siteId)),
  );
  const privateSiteQuery = limit(
    project(matchingPrivateSites, {
      id: matchingPrivateSites.columns.left_left_id,
      name: matchingPrivateSites.columns.left_left_name,
      domain: matchingPrivateSites.columns.left_left_domain,
      ownerUserId: matchingPrivateSites.columns.left_right_owner_user_id,
      role: matchingPrivateSites.columns.right_role,
      siteIdsJson: matchingPrivateSites.columns.right_site_ids_json,
    }),
    1,
  );
  const site = withSiteId(
    await database(env).first(
      compileD1Query(privateSiteQuery, { tag: "auth.sites.first" }),
    ),
  );
  if (!site) return notFound("Site not found", undefined, request);
  if (site.ownerUserId === session.userId) return { ...site, canManage: true };
  if (site.role === "owner" || site.role === "admin") {
    return { ...site, canManage: true };
  }
  if (
    site.role &&
    canAccessMemberSite(parseMemberSiteIdsJson(site.siteIdsJson), siteId)
  ) {
    return { ...site, canManage: false };
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
    const teams = scan(schema.teams);
    const matchingTeams = filter(teams, eq(teams.columns.id, param(teamId)));
    const team = await database(env).first(
      compileD1Query(
        limit(project(matchingTeams, { id: matchingTeams.columns.id }), 1),
        { tag: "auth.teams.first" },
      ),
    );
    return team?.id
      ? { id: team.id }
      : notFound("Team not found", undefined, request);
  }

  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const teamMembers = join(
    teams,
    members,
    and(
      eq(teams.columns.id, members.columns.team_id),
      eq(members.columns.user_id, param(session.userId)),
    ),
    "left",
  );
  const matchingTeams = filter(
    teamMembers,
    eq(teamMembers.columns.left_id, param(teamId)),
  );
  const teamQuery = limit(
    project(matchingTeams, {
      id: matchingTeams.columns.left_id,
      ownerUserId: matchingTeams.columns.left_owner_user_id,
      role: matchingTeams.columns.right_role,
      siteIdsJson: matchingTeams.columns.right_site_ids_json,
    }),
    1,
  );
  const teamRow = await database(env).first(
    compileD1Query(teamQuery, { tag: "auth.teams.first" }),
  );
  if (!teamRow || teamRow.id === null)
    return notFound("Team not found", undefined, request);
  const team = { ...teamRow, id: teamRow.id };
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

  const sites = scan(schema.sites);
  const publicSites = filter(
    sites,
    and(
      eq(sites.columns.public_enabled, param(1)),
      eq(sites.columns.public_slug, param(slug)),
    ),
  );
  const site = withSiteId(
    await database(env).first(
      compileD1Query(
        limit(
          project(publicSites, {
            id: publicSites.columns.id,
            name: publicSites.columns.name,
            domain: publicSites.columns.domain,
          }),
          1,
        ),
        { tag: "auth.sites.first" },
      ),
    ),
  );
  return site ?? notFound("Public site not found");
}
