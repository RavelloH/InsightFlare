import { toTeamRole } from "@/lib/dashboard/permissions";
import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  limit,
  neq,
  param,
  project,
  scan,
  schema,
} from "@/lib/db";
import type { Actor } from "@/lib/edge/admin/auth";
import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/auth/member-site-access";
import type { Env } from "@/lib/edge/types";

function database(env: Pick<Env, "DB">) {
  return createD1DatabaseClient(env.DB);
}

export const toSlug = (v: string) =>
  v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
export interface TeamMembershipAccess {
  role: string;
  siteIds: string[];
}
export async function teamMembershipAccess(
  env: Env,
  teamId: string,
  userId: string,
): Promise<TeamMembershipAccess | null> {
  const members = scan(schema.team_members);
  const matching = filter(
    members,
    and(
      eq(members.columns.team_id, param(teamId)),
      eq(members.columns.user_id, param(userId)),
    ),
  );
  const query = compileD1Query(
    limit(
      project(matching, {
        role: matching.columns.role,
        siteIdsJson: matching.columns.site_ids_json,
      }),
      1,
    ),
    { tag: "admin.team_members.first" },
  );
  const row = await database(env).first(query);
  if (!row) return null;
  return {
    role: row.role,
    siteIds: parseMemberSiteIdsJson(row.siteIdsJson ?? "[]"),
  };
}
export async function teamById(
  env: Env,
  teamId: string,
): Promise<{ id: string; ownerUserId: string } | null> {
  const teams = scan(schema.teams);
  const matching = filter(teams, eq(teams.columns.id, param(teamId)));
  const query = compileD1Query(
    limit(
      project(matching, {
        id: matching.columns.id,
        ownerUserId: matching.columns.owner_user_id,
      }),
      1,
    ),
    { tag: "admin.teams.first" },
  );
  const row = await database(env).first(query);
  if (!row) return null;
  if (typeof row.id !== "string") throw new Error("team_row_missing_id");
  return { id: row.id, ownerUserId: row.ownerUserId };
}
async function siteTeam(env: Env, siteId: string): Promise<string | null> {
  const sites = scan(schema.sites);
  const matching = filter(sites, eq(sites.columns.id, param(siteId)));
  const query = compileD1Query(
    limit(project(matching, { team_id: matching.columns.team_id }), 1),
    { tag: "admin.sites.first" },
  );
  const row = await database(env).first(query);
  return row?.team_id ?? null;
}
export async function canReadTeam(
  env: Env,
  a: Actor,
  teamId: string,
): Promise<boolean> {
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  return Boolean(await teamMembershipAccess(env, teamId, a.user.id));
}
export async function canManageTeam(
  env: Env,
  a: Actor,
  teamId: string,
): Promise<boolean> {
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  const membership = await teamMembershipAccess(env, teamId, a.user.id);
  const r = toTeamRole(membership?.role);
  return r === "owner" || r === "admin";
}
export async function canAdministerTeam(
  env: Env,
  a: Actor,
  teamId: string,
): Promise<boolean> {
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  return (
    toTeamRole((await teamMembershipAccess(env, teamId, a.user.id))?.role) ===
    "owner"
  );
}
export async function canReadSite(
  env: Env,
  a: Actor,
  siteId: string,
): Promise<boolean> {
  const teamId = await siteTeam(env, siteId);
  if (!teamId) return false;
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  const membership = await teamMembershipAccess(env, teamId, a.user.id);
  if (!membership) return false;
  const role = toTeamRole(membership.role);
  if (role === "owner" || role === "admin") return true;
  return canAccessMemberSite(membership.siteIds, siteId);
}
export async function canManageSite(
  env: Env,
  a: Actor,
  siteId: string,
): Promise<boolean> {
  const teamId = await siteTeam(env, siteId);
  if (!teamId) return false;
  return canManageTeam(env, a, teamId);
}
export async function uniqueTeamSlug(
  env: Env,
  raw: string,
  excludeTeamId?: string,
): Promise<string> {
  const base = toSlug(raw) || `team-${Date.now()}`;
  const teams = scan(schema.teams);
  const client = database(env);
  let slug = base;
  let i = 2;
  while (true) {
    const matching = filter(
      teams,
      excludeTeamId
        ? and(
            eq(teams.columns.slug, param(slug)),
            neq(teams.columns.id, param(excludeTeamId)),
          )
        : eq(teams.columns.slug, param(slug)),
    );
    const query = compileD1Query(
      limit(project(matching, { slug: matching.columns.slug }), 1),
      { tag: "admin.teams.first" },
    );
    if (!(await client.first(query))) return slug;
    slug = `${base}-${i}`;
    i += 1;
  }
}
