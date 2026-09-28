import { normalizeTimeZone } from "@/lib/analytics/time-zone";
import {
  aggregate,
  and,
  callFunction,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  count,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  filter,
  insert,
  limit,
  neq,
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
import { uniqueTeamSlug } from "@/lib/edge/admin/access";
import {
  byId,
  byIdentifier,
  ensureBootstrapAdmin,
  hashPassword,
  normE,
  normU,
  requireActor,
  teamGroupsForSession,
  teamsFor,
  toPublicUser,
  verifyPassword,
} from "@/lib/edge/admin/auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
  toRole,
  una,
} from "@/lib/edge/admin/response";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import { isValidLocale } from "@/lib/i18n/config";

function database(env: Env) {
  return createD1DatabaseClient(env.DB);
}

function teamCountFor(userId: SqlExpression<string | null>) {
  const members = scan(schema.team_members);
  const matchingMembers = filter(members, eq(members.columns.user_id, userId));
  return coalesce(
    scalar(
      aggregate(matchingMembers, {
        groupBy: {},
        aggregates: { count: count() },
      }),
    ),
    param(0),
  );
}

function ownedTeamCountFor(userId: SqlExpression<string | null>) {
  const teams = scan(schema.teams);
  const matchingTeams = filter(teams, eq(teams.columns.owner_user_id, userId));
  return coalesce(
    scalar(
      aggregate(matchingTeams, {
        groupBy: {},
        aggregates: { count: count() },
      }),
    ),
    param(0),
  );
}

async function userExists(
  env: Env,
  field: "username" | "email",
  value: string,
  excludeId?: string,
): Promise<boolean> {
  const users = scan(schema.users);
  const identityMatches =
    field === "username"
      ? eq(callFunction("lower", users.columns.username), param(value))
      : eq(callFunction("lower", users.columns.email), param(value));
  const matching = filter(
    users,
    excludeId
      ? and(identityMatches, neq(users.columns.id, param(excludeId)))
      : identityMatches,
  );
  const selected = project(matching, { id: matching.columns.id });
  const row = await database(env).first(
    compileD1Query(limit(selected, 1), { tag: "admin.users.first" }),
  );
  return row !== null;
}

function defaultOwnedTeamName(input: { name: string; username: string }) {
  const displayName = clampString(
    (input.name || input.username || "User").trim(),
    100,
  );
  return `${displayName}'s team`;
}
export async function handleAuthLoginAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") return na(req);
  try {
    await ensureBootstrapAdmin(env);
  } catch (error) {
    void error;
    return jsonResponseFor(
      req,
      { ok: false, error: "bootstrap_admin_failed" },
      500,
    );
  }
  const body = await parseJson(req);
  const identifier = clampString(
    String(body.username || body.email || ""),
    200,
  );
  const password = String(body.password || "");
  if (identifier.length < 3 || !password)
    return bad("username/email and password are required", undefined, req);
  const user = await byIdentifier(env, identifier);
  if (!user) return una("Invalid credentials", undefined, req);
  const verified = await verifyPassword(password, user.password_hash);
  if (!verified) return una("Invalid credentials", undefined, req);
  return jsonResponseFor(req, {
    ok: true,
    data: { user: toPublicUser(user), teams: await teamsFor(env, user.id) },
  });
}
export async function handleAuthMeAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "GET") return na(req);
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  const sessionTeams = await teamGroupsForSession(env, a);
  return jsonResponseFor(req, {
    ok: true,
    data: { user: toPublicUser(a.user), ...sessionTeams },
  });
}
export async function handleUsersAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (!a.isAdmin)
    return forb("Only system admin can manage accounts", undefined, req);
  if (req.method === "GET") {
    const users = scan(schema.users);
    const selected = project(users, {
      id: users.columns.id,
      username: users.columns.username,
      email: users.columns.email,
      name: users.columns.name,
      systemRole: users.columns.system_role,
      timeZone: users.columns.timezone,
      preferredLocale: users.columns.preferred_locale,
      createdAt: users.columns.created_at,
      updatedAt: users.columns.updated_at,
      teamCount: teamCountFor(users.columns.id),
      ownedTeamCount: ownedTeamCountFor(users.columns.id),
    });
    const rows = await database(env).all(
      compileD1Query(
        sort(selected, [
          { expression: selected.columns.createdAt, direction: "ASC" },
        ]),
        { tag: "admin.team_members.all" },
      ),
    );
    return jsonResponseFor(req, { ok: true, data: rows.results });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const username = normU(String(body.username || ""));
    const email = normE(String(body.email || ""));
    const name = clampString(String(body.name || ""), 120);
    const password = String(body.password || "");
    const systemRole = toRole(body.systemRole);
    const teamName = clampString(
      String(body.teamName || "").trim() ||
        defaultOwnedTeamName({ name, username }),
      120,
    );
    const teamSlugInput = clampString(String(body.teamSlug || "").trim(), 80);
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username))
      return bad("Invalid username", undefined, req);
    if (email.length < 3 || !email.includes("@"))
      return bad("A valid email is required", undefined, req);
    if (password.length < 8)
      return bad("Password must be at least 8 characters", undefined, req);
    if (teamName.length < 2)
      return bad("Team name is required", undefined, req);
    if (await userExists(env, "username", username))
      return bad("Username already exists", undefined, req);
    if (await userExists(env, "email", email))
      return bad("Email already exists", undefined, req);
    const id = crypto.randomUUID();
    const teamId = crypto.randomUUID();
    const teamSlug = await uniqueTeamSlug(
      env,
      teamSlugInput || `${username}-team`,
    );
    const pass = await hashPassword(password);
    await database(env).batch([
      compileD1Mutation(
        insert(schema.users, {
          id,
          username,
          email,
          name,
          password_hash: pass,
          system_role: systemRole,
          created_at: unixepoch(),
          updated_at: unixepoch(),
        }),
        { tag: "admin.users.create" },
      ),
      compileD1Mutation(
        insert(schema.teams, {
          id: teamId,
          name: teamName,
          slug: teamSlug,
          owner_user_id: id,
          created_at: unixepoch(),
          updated_at: unixepoch(),
        }),
        { tag: "admin.teams.create_for_user" },
      ),
      compileD1Mutation(
        insert(schema.team_members, {
          team_id: teamId,
          user_id: id,
          role: "owner",
          joined_at: unixepoch(),
        }),
        { tag: "admin.team_members.create_user_owner" },
      ),
    ]);
    const created = await byId(env, id);
    if (!created) return bad("Failed to create account", undefined, req);
    return jsonResponseFor(req, {
      ok: true,
      data: {
        ...toPublicUser(created),
        team: {
          id: teamId,
          name: teamName,
          slug: teamSlug,
          ownerUserId: id,
          membershipRole: "owner",
          siteCount: 0,
          memberCount: 1,
        },
      },
    });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(String(body.intent || ""), 24).toLowerCase();
    const id = clampString(String(body.userId || ""), 120);
    if (!id) return bad("userId is required", undefined, req);

    if (intent === "remove" || intent === "delete") {
      if (id === a.user.id)
        return bad("Cannot delete current user", undefined, req);
      const target = await byId(env, id);
      if (!target) return nf("User not found", undefined, req);

      const teams = scan(schema.teams);
      const ownedTeams = filter(
        teams,
        eq(teams.columns.owner_user_id, param(id)),
      );
      const countQuery = aggregate(ownedTeams, {
        groupBy: {},
        aggregates: { count: count() },
      });
      const ownerTeamCount = await database(env).first(
        compileD1Query(countQuery, { tag: "admin.teams.first" }),
      );
      if (Number(ownerTeamCount?.count ?? 0) > 0) {
        return bad("Cannot delete user that owns teams", undefined, req);
      }

      await database(env).run(
        compileD1Mutation(
          deleteFrom(schema.users, (columns) => eq(columns.id, param(id))),
          { tag: "admin.users.delete" },
        ),
      );
      return jsonResponseFor(req, {
        ok: true,
        data: { userId: id, removed: true },
      });
    }

    const e = await byId(env, id);
    if (!e) return nf("User not found", undefined, req);
    const username = normU(String(body.username ?? e.username));
    const email = normE(String(body.email ?? e.email));
    const name = clampString(String(body.name ?? e.name ?? ""), 120);
    const role = toRole(body.systemRole ?? e.system_role);
    const password = String(body.password || "");
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username))
      return bad("Invalid username", undefined, req);
    if (email.length < 3 || !email.includes("@"))
      return bad("A valid email is required", undefined, req);
    if (password.length > 0 && password.length < 8)
      return bad("Password must be at least 8 characters", undefined, req);
    if (await userExists(env, "username", username, id))
      return bad("Username already exists", undefined, req);
    if (await userExists(env, "email", email, id))
      return bad("Email already exists", undefined, req);
    const pass =
      password.length > 0 ? await hashPassword(password) : e.password_hash;
    await database(env).run(
      compileD1Mutation(
        update(schema.users, (columns) => ({
          set: {
            username,
            email,
            name,
            password_hash: pass,
            system_role: role,
            updated_at: unixepoch(),
          },
          where: eq(columns.id, param(id)),
        })),
        { tag: "admin.users.update" },
      ),
    );
    const u = await byId(env, id);
    if (!u) return bad("Failed to update account", undefined, req);
    return jsonResponseFor(req, { ok: true, data: toPublicUser(u) });
  }
  return na(req);
}
export async function handleProfileAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET")
    return jsonResponseFor(req, {
      ok: true,
      data: {
        user: toPublicUser(a.user),
        teams: await teamsFor(env, a.user.id),
      },
    });
  if (req.method === "POST" || req.method === "PATCH") {
    const body = await parseJson(req);
    const username = normU(String(body.username ?? a.user.username));
    const email = normE(String(body.email ?? a.user.email));
    const name = clampString(String(body.name ?? a.user.name ?? ""), 120);
    const currentPassword = String(body.currentPassword || "");
    const password = String(body.password || "");
    const rawTimeZone = String(
      body.timeZone ?? body.timezone ?? a.user.timezone ?? "",
    ).trim();
    const timeZone = rawTimeZone ? normalizeTimeZone(rawTimeZone) : "";
    const rawPreferredLocale = Object.prototype.hasOwnProperty.call(
      body,
      "preferredLocale",
    )
      ? String(body.preferredLocale ?? "").trim()
      : a.user.preferred_locale || "";
    const preferredLocale =
      rawPreferredLocale === "" || isValidLocale(rawPreferredLocale)
        ? rawPreferredLocale
        : null;
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username))
      return bad("Invalid username", undefined, req);
    if (email.length < 3 || !email.includes("@"))
      return bad("A valid email is required", undefined, req);
    if (rawTimeZone && !timeZone)
      return bad("Invalid timezone", undefined, req);
    if (preferredLocale === null)
      return bad("Invalid preferred locale", undefined, req);
    if (password.length > 0) {
      if (password.length < 8)
        return bad("Password must be at least 8 characters", undefined, req);
      if (!(await verifyPassword(currentPassword, a.user.password_hash)))
        return bad("Current password is incorrect", undefined, req);
    }
    if (await userExists(env, "username", username, a.user.id))
      return bad("Username already exists", undefined, req);
    if (await userExists(env, "email", email, a.user.id))
      return bad("Email already exists", undefined, req);
    const pass =
      password.length > 0 ? await hashPassword(password) : a.user.password_hash;
    await database(env).run(
      compileD1Mutation(
        update(schema.users, (columns) => ({
          set: {
            username,
            email,
            name,
            password_hash: pass,
            timezone: timeZone,
            preferred_locale: preferredLocale,
            updated_at: unixepoch(),
          },
          where: eq(columns.id, param(a.user.id)),
        })),
        { tag: "admin.users.update_profile" },
      ),
    );
    const u = await byId(env, a.user.id);
    if (!u) return bad("Failed to update profile", undefined, req);
    return jsonResponseFor(req, { ok: true, data: toPublicUser(u) });
  }
  return na(req);
}
