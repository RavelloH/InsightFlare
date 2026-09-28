import { type TeamRole, toTeamRole } from "@/lib/dashboard/permissions";
import {
  aggregate,
  and,
  compileD1Mutation,
  compileD1Query,
  count,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  excluded,
  filter,
  insert,
  join,
  limit,
  onConflictDoUpdate,
  param,
  project,
  scalar,
  scan,
  schema,
  sort,
  unixepoch,
  update,
} from "@/lib/db";
import type { SqlExpression } from "@/lib/db/query/expression";
import {
  canAdministerTeam,
  canManageTeam,
  canReadTeam,
  teamById,
  toSlug,
  uniqueTeamSlug,
} from "@/lib/edge/admin/access";
import {
  byId,
  byIdentifier,
  requireActor,
  teamsFor,
} from "@/lib/edge/admin/auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "@/lib/edge/admin/response";
import { teamDeletionMutations } from "@/lib/edge/admin/teams/deletion";
import {
  assertSitesBelongToTeam,
  normalizeMemberSiteIds,
  parseMemberSiteIdsJson,
  serializeMemberSiteIds,
} from "@/lib/edge/auth/member-site-access";
import { deleteSiteScriptSettings } from "@/lib/edge/sites/settings-store";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";

function database(env: Env) {
  return createD1DatabaseClient(env.DB);
}

function siteCountFor(teamId: SqlExpression<string | null>) {
  const sites = scan(schema.sites);
  const matchingSites = filter(sites, eq(sites.columns.team_id, teamId));
  return scalar(
    aggregate(matchingSites, {
      groupBy: {},
      aggregates: { count: count() },
    }),
  );
}

function memberCountFor(teamId: SqlExpression<string | null>) {
  const members = scan(schema.team_members);
  const matchingMembers = filter(members, eq(members.columns.team_id, teamId));
  return scalar(
    aggregate(matchingMembers, {
      groupBy: {},
      aggregates: { count: count() },
    }),
  );
}

function teamByIdQuery(teamId: string) {
  const teams = scan(schema.teams);
  const matching = filter(teams, eq(teams.columns.id, param(teamId)));
  return limit(
    project(matching, {
      id: matching.columns.id,
      name: matching.columns.name,
      slug: matching.columns.slug,
      ownerUserId: matching.columns.owner_user_id,
      createdAt: matching.columns.created_at,
      updatedAt: matching.columns.updated_at,
    }),
    1,
  );
}

function membershipByTeamAndUser(teamId: string, userId: string) {
  const members = scan(schema.team_members);
  const matching = filter(
    members,
    and(
      eq(members.columns.team_id, param(teamId)),
      eq(members.columns.user_id, param(userId)),
    ),
  );
  return limit(project(matching, { role: matching.columns.role }), 1);
}
export async function handleTeamsAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    if (a.isAdmin) {
      const teams = scan(schema.teams);
      const selected = project(teams, {
        id: teams.columns.id,
        name: teams.columns.name,
        slug: teams.columns.slug,
        ownerUserId: teams.columns.owner_user_id,
        createdAt: teams.columns.created_at,
        updatedAt: teams.columns.updated_at,
        membershipRole: param("owner"),
        siteCount: siteCountFor(teams.columns.id),
        memberCount: memberCountFor(teams.columns.id),
      });
      const rows = await database(env).all(
        compileD1Query(
          sort(selected, [
            { expression: selected.columns.createdAt, direction: "DESC" },
          ]),
          { tag: "admin.sites.all" },
        ),
      );
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
    await database(env).run(
      compileD1Mutation(
        insert(schema.teams, {
          id: teamId,
          name,
          slug,
          owner_user_id: a.user.id,
          created_at: unixepoch(),
          updated_at: unixepoch(),
        }),
        { tag: "admin.teams.insert" },
      ),
    );
    await database(env).run(
      compileD1Mutation(
        insert(schema.team_members, {
          team_id: teamId,
          user_id: a.user.id,
          role: param("owner"),
          joined_at: unixepoch(),
        }),
        { tag: "admin.team_members.insert_owner" },
      ),
    );
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

    const existingRow = await database(env).first(
      compileD1Query(teamByIdQuery(teamId), { tag: "admin.teams.first" }),
    );
    if (!existingRow || existingRow.id === null)
      return nf("Team not found", undefined, req);
    const existing = {
      ...existingRow,
      id: existingRow.id,
      name: existingRow.name ?? "",
      slug: existingRow.slug ?? "",
      ownerUserId: existingRow.ownerUserId ?? "",
      createdAt: existingRow.createdAt ?? 0,
      updatedAt: existingRow.updatedAt ?? 0,
    };

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
      const targetMembership = await database(env).first(
        compileD1Query(membershipByTeamAndUser(teamId, newOwnerUserId), {
          tag: "admin.team_members.first",
        }),
      );
      if (!targetMembership)
        return bad("Target user is not a team member", undefined, req);

      await database(env).batch([
        compileD1Mutation(
          update(schema.teams, (columns) => ({
            set: {
              owner_user_id: newOwnerUserId,
              updated_at: unixepoch(),
            },
            where: eq(columns.id, param(teamId)),
          })),
          { tag: "admin.teams.transfer_owner" },
        ),
        compileD1Mutation(
          onConflictDoUpdate(
            insert(schema.team_members, {
              team_id: teamId,
              user_id: newOwnerUserId,
              role: param("owner"),
              joined_at: unixepoch(),
            }),
            ["team_id", "user_id"],
            { role: param("owner") },
          ),
          { tag: "admin.team_members.promote_owner" },
        ),
        compileD1Mutation(
          update(schema.team_members, (columns) => ({
            set: { role: param("admin") },
            where: and(
              eq(columns.team_id, param(teamId)),
              eq(columns.user_id, param(existing.ownerUserId)),
            ),
          })),
          { tag: "admin.team_members.demote_previous_owner" },
        ),
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
      const sites = scan(schema.sites);
      const teamSites = filter(sites, eq(sites.columns.team_id, param(teamId)));
      const siteIdRows = project(teamSites, { id: teamSites.columns.id });
      const siteRows = await database(env).all(
        compileD1Query(siteIdRows, { tag: "admin.sites.all" }),
      );
      const siteIds = siteRows.results.map(({ id }) => {
        if (id === null) throw new Error("team_site_missing_id");
        return id;
      });

      if (siteIds.length > 0) {
        const client = database(env);
        for (const mutation of teamDeletionMutations(siteIds))
          await client.run(mutation);

        await Promise.allSettled(
          siteIds.map((id) => deleteSiteScriptSettings(env, id)),
        );
      }

      await database(env).run(
        compileD1Mutation(
          deleteFrom(schema.teams, (columns) => eq(columns.id, param(teamId))),
          { tag: "admin.teams.delete" },
        ),
      );
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

    await database(env).run(
      compileD1Mutation(
        update(schema.teams, (columns) => ({
          set: { name, slug, updated_at: unixepoch() },
          where: eq(columns.id, param(teamId)),
        })),
        { tag: "admin.teams.update" },
      ),
    );

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
    const members = scan(schema.team_members);
    const users = scan(schema.users);
    const joined = join(
      members,
      users,
      eq(members.columns.user_id, users.columns.id),
    );
    const matching = filter(
      joined,
      eq(joined.columns.left_team_id, param(teamId)),
    );
    const selected = project(matching, {
      teamId: matching.columns.left_team_id,
      userId: matching.columns.left_user_id,
      role: matching.columns.left_role,
      siteIdsJson: matching.columns.left_site_ids_json,
      joinedAt: matching.columns.left_joined_at,
      username: matching.columns.right_username,
      email: matching.columns.right_email,
      name: matching.columns.right_name,
    });
    const rows = await database(env).all(
      compileD1Query(
        sort(selected, [
          { expression: selected.columns.joinedAt, direction: "ASC" },
        ]),
        { tag: "admin.team_members.all" },
      ),
    );
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
      await database(env).run(
        compileD1Mutation(
          onConflictDoUpdate(
            insert(schema.team_members, {
              team_id: teamId,
              user_id: m.id,
              role: param("owner"),
              joined_at: unixepoch(),
            }),
            ["team_id", "user_id"],
            { role: param("owner") },
          ),
          { tag: "admin.team_members.ensure_owner" },
        ),
      );
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
    const existingRole = await database(env).first(
      compileD1Query(membershipByTeamAndUser(teamId, m.id), {
        tag: "admin.team_members.first",
      }),
    );
    if (existingRole && toTeamRole(existingRole.role) === "owner")
      return forb("Cannot change team owner membership", undefined, req);
    await database(env).run(
      compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.team_members, {
            team_id: teamId,
            user_id: m.id,
            role: targetRole,
            site_ids_json: serializeMemberSiteIds(siteIds),
            joined_at: unixepoch(),
          }),
          ["team_id", "user_id"],
          {
            role: excluded(schema.team_members.columns.role),
            site_ids_json: excluded(schema.team_members.columns.site_ids_json),
          },
        ),
        { tag: "admin.team_members.upsert" },
      ),
    );
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
    const existing = await database(env).first(
      compileD1Query(membershipByTeamAndUser(teamId, userId), {
        tag: "admin.team_members.first",
      }),
    );
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
      await database(env).run(
        compileD1Mutation(
          update(schema.team_members, (columns) => ({
            set: { role: nextRole },
            where: and(
              eq(columns.team_id, param(teamId)),
              eq(columns.user_id, param(userId)),
            ),
          })),
          { tag: "admin.team_members.update_role" },
        ),
      );
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
      await database(env).run(
        compileD1Mutation(
          update(schema.team_members, (columns) => ({
            set: { site_ids_json: serializeMemberSiteIds(siteIds) },
            where: and(
              eq(columns.team_id, param(teamId)),
              eq(columns.user_id, param(userId)),
            ),
          })),
          { tag: "admin.team_members.update_sites" },
        ),
      );
      return jsonResponseFor(req, {
        ok: true,
        data: { teamId, userId, siteIds, updated: true },
      });
    }

    if (userId === team.ownerUserId || existingRole === "owner")
      return bad("Cannot remove team owner", undefined, req);
    await database(env).run(
      compileD1Mutation(
        deleteFrom(schema.team_members, (columns) =>
          and(
            eq(columns.team_id, param(teamId)),
            eq(columns.user_id, param(userId)),
          ),
        ),
        { tag: "admin.team_members.delete" },
      ),
    );
    return jsonResponseFor(req, {
      ok: true,
      data: { teamId, userId, removed: true },
    });
  }
  return na(req);
}
