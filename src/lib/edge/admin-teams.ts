import { type TeamRole, toTeamRole } from "@/lib/dashboard/permissions";

import {
  canAdministerTeam,
  canManageTeam,
  canReadTeam,
  teamById,
  toSlug,
  uniqueTeamSlug,
} from "./admin-access";
import { byId, byIdentifier, requireActor, teamsFor } from "./admin-auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "./admin-response";
import {
  assertSitesBelongToTeam,
  normalizeMemberSiteIds,
  parseMemberSiteIdsJson,
  serializeMemberSiteIds,
} from "./member-site-access";
import { deleteSiteScriptSettings } from "./site-settings-store";
import type { Env } from "./types";
import { clampString } from "./utils";

const MAX_SITE_IDS_PER_D1_QUERY = 100;

async function deleteForSiteIds(
  env: Env,
  siteIds: string[],
  sql: (placeholders: string) => string,
): Promise<void> {
  for (
    let index = 0;
    index < siteIds.length;
    index += MAX_SITE_IDS_PER_D1_QUERY
  ) {
    const chunk = siteIds.slice(index, index + MAX_SITE_IDS_PER_D1_QUERY);
    const placeholders = chunk.map(() => "?").join(",");
    await env.DB.prepare(sql(placeholders))
      .bind(...chunk)
      .run();
  }
}

export async function handleTeamsAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    if (a.isAdmin) {
      const rows = await env.DB.prepare(
        "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,'owner' AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t ORDER BY t.created_at DESC",
      ).all<Record<string, unknown>>();
      return jsonResponseFor(req, {
        ok: true,
        data: rows.results.map((row) => ({
          ...row,
          membershipRole: toTeamRole(row.membershipRole),
        })),
      });
    }
    return jsonResponseFor(req, {
      ok: true,
      data: await teamsFor(env, a.user.id),
    });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const name = clampString(String(body.name || ""), 120);
    if (name.length < 2) return bad("Team name is required", undefined, req);
    const slug = await uniqueTeamSlug(
      env,
      clampString(String(body.slug || toSlug(name)), 80),
    );
    const teamId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
    )
      .bind(teamId, name, slug, a.user.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
    )
      .bind(teamId, a.user.id)
      .run();
    return jsonResponseFor(req, {
      ok: true,
      data: {
        id: teamId,
        name,
        slug,
        ownerUserId: a.user.id,
        membershipRole: "owner",
      },
    });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(String(body.intent || ""), 24).toLowerCase();
    const teamId = clampString(String(body.teamId || ""), 120);
    if (!teamId) return bad("teamId is required", undefined, req);
    if (!(await canManageTeam(env, a, teamId)))
      return forb("Only team owner can update team", undefined, req);

    const existing = await env.DB.prepare(
      "SELECT id,name,slug,owner_user_id AS ownerUserId,created_at AS createdAt,updated_at AS updatedAt FROM teams WHERE id=? LIMIT 1",
    )
      .bind(teamId)
      .first<{
        id: string;
        name: string;
        slug: string;
        ownerUserId: string;
        createdAt: number;
        updatedAt: number;
      }>();
    if (!existing) return nf("Team not found", undefined, req);

    if (intent === "transfer_owner") {
      if (existing.ownerUserId !== a.user.id) {
        return forb(
          "Only the team owner can transfer ownership",
          undefined,
          req,
        );
      }
      const newOwnerUserId = clampString(
        String(body.newOwnerUserId || ""),
        120,
      );
      if (!newOwnerUserId)
        return bad("newOwnerUserId is required", undefined, req);
      if (newOwnerUserId === existing.ownerUserId) {
        return bad("Already the team owner", undefined, req);
      }
      const targetMembership = await env.DB.prepare(
        "SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1",
      )
        .bind(teamId, newOwnerUserId)
        .first<{ role: string }>();
      if (!targetMembership)
        return bad("Target user is not a team member", undefined, req);

      await env.DB.batch([
        env.DB.prepare(
          "UPDATE teams SET owner_user_id=?,updated_at=unixepoch() WHERE id=?",
        ).bind(newOwnerUserId, teamId),
        env.DB.prepare(
          "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
        ).bind(teamId, newOwnerUserId),
        env.DB.prepare(
          "UPDATE team_members SET role='admin' WHERE team_id=? AND user_id=?",
        ).bind(teamId, existing.ownerUserId),
      ]);

      return jsonResponseFor(req, {
        ok: true,
        data: {
          id: teamId,
          name: existing.name,
          slug: existing.slug,
          ownerUserId: newOwnerUserId,
          createdAt: existing.createdAt,
          updatedAt: Math.floor(Date.now() / 1000),
          transferred: true,
        },
      });
    }

    if (intent === "remove" || intent === "delete") {
      if (!(await canAdministerTeam(env, a, teamId)))
        return forb("Only team owner can delete team", undefined, req);
      const siteRows = await env.DB.prepare(
        "SELECT id FROM sites WHERE team_id=?",
      )
        .bind(teamId)
        .all<{ id: string }>();
      const siteIds = siteRows.results.map((row) => row.id);

      if (siteIds.length > 0) {
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_event_json_values WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders})))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_events WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_event_names WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_event_json_keys WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM custom_event_json_paths WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM visits WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM visit_hourly_rollups WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        await deleteForSiteIds(
          env,
          siteIds,
          (placeholders) =>
            `DELETE FROM visit_hourly_aggregation_state WHERE site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`,
        );
        const configKeys = siteIds.map((id) => `site:${id}`);
        await deleteForSiteIds(
          env,
          configKeys,
          (placeholders) =>
            `DELETE FROM configs WHERE config_key IN (${placeholders})`,
        );

        await Promise.allSettled(
          siteIds.map((id) => deleteSiteScriptSettings(env, id)),
        );
      }

      await env.DB.prepare("DELETE FROM teams WHERE id=?").bind(teamId).run();
      return jsonResponseFor(req, {
        ok: true,
        data: { teamId, removed: true },
      });
    }

    const nameInput = clampString(String(body.name || ""), 120);
    const slugInput = clampString(String(body.slug || ""), 80);
    const name = nameInput || existing.name;
    if (name.length < 2) return bad("Team name is required", undefined, req);
    const slug =
      slugInput.length > 0
        ? await uniqueTeamSlug(env, slugInput, teamId)
        : await uniqueTeamSlug(env, name, teamId);

    await env.DB.prepare(
      "UPDATE teams SET name=?,slug=?,updated_at=unixepoch() WHERE id=?",
    )
      .bind(name, slug, teamId)
      .run();

    return jsonResponseFor(req, {
      ok: true,
      data: {
        id: teamId,
        name,
        slug,
        ownerUserId: existing.ownerUserId,
        createdAt: existing.createdAt,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  }
  return na(req);
}

export async function handleMembersAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (!teamId) return bad("Missing teamId", undefined, req);
    if (!(await canReadTeam(env, a, teamId)))
      return forb("Team access denied", undefined, req);
    const rows = await env.DB.prepare(
      "SELECT tm.team_id AS teamId,tm.user_id AS userId,tm.role,tm.site_ids_json AS siteIdsJson,tm.joined_at AS joinedAt,u.username,u.email,u.name FROM team_members tm INNER JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY tm.joined_at ASC",
    )
      .bind(teamId)
      .all<Record<string, unknown>>();
    return jsonResponseFor(req, {
      ok: true,
      data: rows.results.map((row) => {
        const { siteIdsJson: _siteIdsJson, ...rest } = row;
        return {
          ...rest,
          role: toTeamRole(row.role),
          siteIds: parseMemberSiteIdsJson(_siteIdsJson),
        };
      }),
    });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    const userId = clampString(String(body.userId || ""), 120);
    const identifier = clampString(
      String(body.identifier || body.username || body.email || ""),
      200,
    );
    if (!teamId || (!userId && !identifier))
      return bad("teamId and user identifier are required", undefined, req);
    const team = await teamById(env, teamId);
    if (!team) return nf("Team not found", undefined, req);
    if (!(await canManageTeam(env, a, teamId)))
      return forb("Only team owner can manage members", undefined, req);
    const m = userId
      ? await byId(env, userId)
      : await byIdentifier(env, identifier);
    if (!m) return nf("User not found", undefined, req);
    if (m.id === team.ownerUserId) {
      await env.DB.prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
      )
        .bind(teamId, m.id)
        .run();
      return jsonResponseFor(req, {
        ok: true,
        data: {
          teamId,
          userId: m.id,
          role: "owner" as TeamRole,
          siteIds: [],
          username: m.username,
          email: m.email,
          name: m.name || "",
        },
      });
    }
    const requestedRoleRaw = body.role;
    const requestedRole: TeamRole | null =
      requestedRoleRaw === undefined || requestedRoleRaw === null
        ? null
        : toTeamRole(requestedRoleRaw);
    if (requestedRole === "owner")
      return bad(
        "Cannot assign owner via member add; use ownership transfer",
        undefined,
        req,
      );
    const targetRole: TeamRole = requestedRole ?? "member";
    const siteIds =
      targetRole === "member" ? normalizeMemberSiteIds(body.siteIds) : [];
    if (!(await assertSitesBelongToTeam(env, teamId, siteIds))) {
      return bad("siteIds must belong to the team", undefined, req);
    }
    const existingRole = await env.DB.prepare(
      "SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1",
    )
      .bind(teamId, m.id)
      .first<{ role: string }>();
    if (existingRole && toTeamRole(existingRole.role) === "owner")
      return forb("Cannot change team owner membership", undefined, req);
    await env.DB.prepare(
      "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?,?,unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role, site_ids_json=excluded.site_ids_json",
    )
      .bind(teamId, m.id, targetRole, serializeMemberSiteIds(siteIds))
      .run();
    return jsonResponseFor(req, {
      ok: true,
      data: {
        teamId,
        userId: m.id,
        role: targetRole,
        siteIds,
        username: m.username,
        email: m.email,
        name: m.name || "",
      },
    });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(
      String(body.intent || "remove"),
      24,
    ).toLowerCase();
    const teamId = clampString(String(body.teamId || ""), 120);
    const userId = clampString(String(body.userId || ""), 120);
    if (!teamId || !userId)
      return bad("teamId and userId are required", undefined, req);
    const team = await teamById(env, teamId);
    if (!team) return nf("Team not found", undefined, req);
    if (!(await canManageTeam(env, a, teamId)))
      return forb("Only team owner can manage members", undefined, req);
    const existing = await env.DB.prepare(
      "SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1",
    )
      .bind(teamId, userId)
      .first<{ role: string }>();
    if (!existing) return nf("Member not found", undefined, req);
    const existingRole = toTeamRole(existing.role);

    if (intent === "update_role") {
      if (existingRole === "owner" || userId === team.ownerUserId)
        return bad("Cannot change team owner role", undefined, req);
      const nextRole = toTeamRole(body.role);
      if (nextRole === "owner")
        return bad(
          "Cannot promote to owner; use ownership transfer",
          undefined,
          req,
        );
      if (
        userId === a.user.id &&
        nextRole === "member" &&
        !a.isAdmin &&
        team.ownerUserId !== a.user.id
      ) {
        return bad(
          "Cannot demote yourself; ask another admin or the owner",
          undefined,
          req,
        );
      }
      if (nextRole === existingRole) {
        return jsonResponseFor(req, {
          ok: true,
          data: { teamId, userId, role: nextRole, unchanged: true },
        });
      }
      await env.DB.prepare(
        "UPDATE team_members SET role=? WHERE team_id=? AND user_id=?",
      )
        .bind(nextRole, teamId, userId)
        .run();
      return jsonResponseFor(req, {
        ok: true,
        data: { teamId, userId, role: nextRole, updated: true },
      });
    }

    if (intent === "update_site_access") {
      if (existingRole === "owner" || userId === team.ownerUserId)
        return bad("Cannot change team owner site access", undefined, req);
      if (existingRole !== "member") {
        return bad(
          "Site access is only configurable for members",
          undefined,
          req,
        );
      }
      const siteIds = normalizeMemberSiteIds(body.siteIds);
      if (!(await assertSitesBelongToTeam(env, teamId, siteIds))) {
        return bad("siteIds must belong to the team", undefined, req);
      }
      await env.DB.prepare(
        "UPDATE team_members SET site_ids_json=? WHERE team_id=? AND user_id=?",
      )
        .bind(serializeMemberSiteIds(siteIds), teamId, userId)
        .run();
      return jsonResponseFor(req, {
        ok: true,
        data: { teamId, userId, siteIds, updated: true },
      });
    }

    if (userId === team.ownerUserId || existingRole === "owner")
      return bad("Cannot remove team owner", undefined, req);
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id=? AND user_id=?",
    )
      .bind(teamId, userId)
      .run();
    return jsonResponseFor(req, {
      ok: true,
      data: { teamId, userId, removed: true },
    });
  }
  return na(req);
}
