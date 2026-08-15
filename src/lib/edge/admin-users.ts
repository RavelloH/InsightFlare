import { normalizeTimeZone } from "@/lib/dashboard/time-zone";
import { isValidLocale } from "@/lib/i18n/config";

import { uniqueTeamSlug } from "./admin-access";
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
} from "./admin-auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
  toRole,
  una,
} from "./admin-response";
import type { Env } from "./types";
import { clampString } from "./utils";

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
    const rows = await env.DB.prepare(
      "SELECT u.id,u.username,u.email,u.name,u.system_role AS systemRole,u.timezone AS timeZone,u.preferred_locale AS preferredLocale,u.created_at AS createdAt,u.updated_at AS updatedAt,(SELECT COUNT(*) FROM team_members tm WHERE tm.user_id=u.id) AS teamCount,(SELECT COUNT(*) FROM teams t WHERE t.owner_user_id=u.id) AS ownedTeamCount FROM users u ORDER BY u.created_at ASC",
    ).all<Record<string, unknown>>();
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
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(username)=? LIMIT 1",
      )
        .bind(username)
        .first()
    )
      return bad("Username already exists", undefined, req);
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(email)=? LIMIT 1",
      )
        .bind(email)
        .first()
    )
      return bad("Email already exists", undefined, req);
    const id = crypto.randomUUID();
    const teamId = crypto.randomUUID();
    const teamSlug = await uniqueTeamSlug(
      env,
      teamSlugInput || `${username}-team`,
    );
    const pass = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
      ).bind(id, username, email, name, pass, systemRole),
      env.DB.prepare(
        "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
      ).bind(teamId, teamName, teamSlug, id),
      env.DB.prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
      ).bind(teamId, id),
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

      const ownedTeams = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM teams WHERE owner_user_id=?",
      )
        .bind(id)
        .first<{ count: number | null }>();
      if (Number(ownedTeams?.count ?? 0) > 0) {
        return bad("Cannot delete user that owns teams", undefined, req);
      }

      await env.DB.prepare("DELETE FROM users WHERE id=?").bind(id).run();
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
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(username)=? AND id<>? LIMIT 1",
      )
        .bind(username, id)
        .first()
    )
      return bad("Username already exists", undefined, req);
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(email)=? AND id<>? LIMIT 1",
      )
        .bind(email, id)
        .first()
    )
      return bad("Email already exists", undefined, req);
    const pass =
      password.length > 0 ? await hashPassword(password) : e.password_hash;
    await env.DB.prepare(
      "UPDATE users SET username=?,email=?,name=?,password_hash=?,system_role=?,updated_at=unixepoch() WHERE id=?",
    )
      .bind(username, email, name, pass, role, id)
      .run();
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
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(username)=? AND id<>? LIMIT 1",
      )
        .bind(username, a.user.id)
        .first()
    )
      return bad("Username already exists", undefined, req);
    if (
      await env.DB.prepare(
        "SELECT 1 AS ok FROM users WHERE lower(email)=? AND id<>? LIMIT 1",
      )
        .bind(email, a.user.id)
        .first()
    )
      return bad("Email already exists", undefined, req);
    const pass =
      password.length > 0 ? await hashPassword(password) : a.user.password_hash;
    await env.DB.prepare(
      "UPDATE users SET username=?,email=?,name=?,password_hash=?,timezone=?,preferred_locale=?,updated_at=unixepoch() WHERE id=?",
    )
      .bind(username, email, name, pass, timeZone, preferredLocale, a.user.id)
      .run();
    const u = await byId(env, a.user.id);
    if (!u) return bad("Failed to update profile", undefined, req);
    return jsonResponseFor(req, { ok: true, data: toPublicUser(u) });
  }
  return na(req);
}
