import { toTeamRole } from "@/lib/dashboard/permissions";
import type { Actor } from "@/lib/edge/admin/auth";
import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/auth/member-site-access";
import type { Env } from "@/lib/edge/types";
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
  const row = await env.DB.prepare(
    "SELECT role,site_ids_json AS siteIdsJson FROM team_members WHERE team_id=? AND user_id=? LIMIT 1",
  )
    .bind(teamId, userId)
    .first<{ role: string; siteIdsJson?: string | null }>();
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
  const row = await env.DB.prepare(
    "SELECT id,owner_user_id AS ownerUserId FROM teams WHERE id=? LIMIT 1",
  )
    .bind(teamId)
    .first<{ id: string; ownerUserId: string }>();
  return row ?? null;
}
async function siteTeam(env: Env, siteId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT team_id FROM sites WHERE id=? LIMIT 1",
  )
    .bind(siteId)
    .first<{ team_id: string }>();
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
  let slug = base;
  let i = 2;
  while (true) {
    const e = excludeTeamId
      ? await env.DB.prepare(
          "SELECT 1 AS ok FROM teams WHERE slug=? AND id<>? LIMIT 1",
        )
          .bind(slug, excludeTeamId)
          .first<{ ok: number }>()
      : await env.DB.prepare("SELECT 1 AS ok FROM teams WHERE slug=? LIMIT 1")
          .bind(slug)
          .first<{ ok: number }>();
    if (!e?.ok) return slug;
    slug = `${base}-${i}`;
    i += 1;
  }
}
