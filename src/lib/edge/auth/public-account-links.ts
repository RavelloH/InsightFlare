import {
  and,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  excluded,
  filter,
  insert,
  isNull,
  limit,
  onConflictDoUpdate,
  param,
  project,
  scan,
  schema,
  unixepoch,
  update,
} from "@/lib/db";
import {
  byId,
  byIdentifier,
  hashPassword,
  normE,
  normU,
  toPublicUser,
} from "@/lib/edge/admin/auth";
import { jsonResponseFor, na, parseJson } from "@/lib/edge/admin/response";
import {
  getValidAccountActionToken,
  markAccountActionTokenUsed,
  toPublicAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import { requireSession } from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";

function database(env: Env) {
  return createD1DatabaseClient(env.DB);
}

import {
  memberSiteIdsFromInvitePayload,
  serializeMemberSiteIds,
} from "./member-site-access";
type TeamInviteRole = "member" | "admin";
interface TeamLinkInfo {
  id: string;
  name: string;
  slug: string;
}
function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}
function ok(req: Request, data: Record<string, unknown>, status = 200) {
  return noStore(jsonResponseFor(req, { ok: true, data }, status));
}
function fail(req: Request, message: string, status = 400) {
  return noStore(jsonResponseFor(req, { ok: false, error: message }, status));
}
function tokenFromBody(body: Record<string, unknown>): string {
  return clampString(String(body.token || "").trim(), 4096);
}
function teamRoleFromPayload(payload: Record<string, unknown>): TeamInviteRole {
  return payload.teamRole === "admin" ? "admin" : "member";
}
function allowsRegistration(payload: Record<string, unknown>): boolean {
  return payload.allowRegistration !== false;
}
function publicInvitePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const safePayload = { ...payload };
  delete safePayload.tokenEncrypted;
  return safePayload;
}
function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!local || !domain) return "";
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}${"*".repeat(Math.max(1, local.length - prefix.length))}@${domain}`;
}
function emailsMatch(left: string, right: string): boolean {
  return normE(left) === normE(right);
}
async function currentUser(env: Env, req: Request) {
  const session = await requireSession(req, env);
  if (!session?.userId) return null;
  return byId(env, clampString(session.userId, 120));
}
async function teamInfo(
  env: Env,
  teamId: string,
): Promise<TeamLinkInfo | null> {
  const teams = scan(schema.teams);
  const matching = filter(teams, eq(teams.columns.id, param(teamId)));
  const selected = project(matching, {
    id: matching.columns.id,
    name: matching.columns.name,
    slug: matching.columns.slug,
  });
  const team = await database(env).first(
    compileD1Query(limit(selected, 1), { tag: "auth.teams.first" }),
  );
  if (!team) return null;
  if (team.id === null) throw new Error("team_row_missing_id");
  return { id: team.id, name: team.name, slug: team.slug };
}
async function completeTeamInviteForUser(input: {
  env: Env;
  req: Request;
  tokenId: string;
  teamId: string;
  role: TeamInviteRole;
  siteIds: string[];
  userId: string;
}) {
  await database(input.env).run(
    compileD1Mutation(
      onConflictDoUpdate(
        insert(schema.team_members, {
          team_id: input.teamId,
          user_id: input.userId,
          role: input.role,
          site_ids_json: serializeMemberSiteIds(
            input.role === "member" ? input.siteIds : [],
          ),
          joined_at: unixepoch(),
        }),
        ["team_id", "user_id"],
        {
          role: excluded(schema.team_members.columns.role),
          site_ids_json: excluded(schema.team_members.columns.site_ids_json),
        },
      ),
      { tag: "auth.team_members.accept_invite" },
    ),
  );
  await markAccountActionTokenUsed(input.env, {
    tokenId: input.tokenId,
    usedByUserId: input.userId,
  });
  const team = await teamInfo(input.env, input.teamId);
  return ok(input.req, {
    type: "team_invite",
    team: team ?? { id: input.teamId },
  });
}
export async function handlePublicAccountLinks(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (req.method !== "POST") return noStore(na(req));

  const action = url.pathname.endsWith("/inspect")
    ? "inspect"
    : url.pathname.endsWith("/complete")
      ? "complete"
      : "";
  if (!action) return fail(req, "Not Found", 404);

  const body = await parseJson(req);
  const token = tokenFromBody(body);
  if (!token) return fail(req, "token is required");

  const row = await getValidAccountActionToken(env, { token });
  if (!row) return fail(req, "Invalid or expired link", 400);
  const publicToken = toPublicAccountActionToken(row);

  if (action === "inspect") {
    if (publicToken.type === "team_invite") {
      const team = await teamInfo(env, publicToken.teamId);
      if (!team) return fail(req, "Team not found", 404);
      const user = await currentUser(env, req);
      const registrationAllowed = allowsRegistration(publicToken.payload);
      return ok(req, {
        type: "team_invite",
        team,
        email: publicToken.email,
        payload: publicInvitePayload(publicToken.payload),
        requiresLogin: !user && !registrationAllowed,
        allowsRegistration: registrationAllowed,
        expiresAt: publicToken.expiresAt,
      });
    }

    if (publicToken.type === "password_reset") {
      const user = publicToken.userId
        ? await byId(env, publicToken.userId)
        : null;
      if (!user) return fail(req, "User not found", 404);
      return ok(req, {
        type: "password_reset",
        user: {
          username: user.username,
          email: maskEmail(user.email),
        },
        expiresAt: publicToken.expiresAt,
      });
    }
  }

  if (publicToken.type === "password_reset") {
    const password = String(body.password || "");
    if (password.length < 8) {
      return fail(req, "Password must be at least 8 characters");
    }
    if (!publicToken.userId) return fail(req, "User not found", 404);
    const passwordHash = await hashPassword(password);
    await database(env).run(
      compileD1Mutation(
        update(schema.users, (columns) => ({
          set: {
            password_hash: passwordHash,
            updated_at: unixepoch(),
          },
          where: eq(columns.id, param(publicToken.userId)),
        })),
        { tag: "auth.users.reset_password" },
      ),
    );
    await markAccountActionTokenUsed(env, {
      tokenId: publicToken.id,
      usedByUserId: publicToken.userId,
    });
    return ok(req, { type: "password_reset", reset: true });
  }

  const team = await teamInfo(env, publicToken.teamId);
  if (!team) return fail(req, "Team not found", 404);

  const role = teamRoleFromPayload(publicToken.payload);
  const siteIds =
    role === "member"
      ? memberSiteIdsFromInvitePayload(publicToken.payload)
      : [];
  const user = await currentUser(env, req);
  if (user) {
    if (publicToken.email && !emailsMatch(user.email, publicToken.email)) {
      return fail(req, "Invite email does not match the signed-in user", 403);
    }
    return completeTeamInviteForUser({
      env,
      req,
      tokenId: publicToken.id,
      teamId: publicToken.teamId,
      role,
      siteIds,
      userId: user.id,
    });
  }

  if (!allowsRegistration(publicToken.payload)) {
    return fail(req, "This invite requires an existing account", 403);
  }

  const username = normU(String(body.username || ""));
  const email = normE(String(body.email || ""));
  const name = clampString(String(body.name || ""), 120);
  const password = String(body.password || "");
  if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username)) {
    return fail(req, "Invalid username");
  }
  if (email.length < 3 || !email.includes("@")) {
    return fail(req, "A valid email is required");
  }
  if (password.length < 8) {
    return fail(req, "Password must be at least 8 characters");
  }
  if (publicToken.email && !emailsMatch(email, publicToken.email)) {
    return fail(req, "Invite email does not match this account", 403);
  }
  if (await byIdentifier(env, email)) {
    return fail(req, "Account already exists; sign in to accept invite", 409);
  }
  if (await byIdentifier(env, username)) {
    return fail(req, "Username already exists");
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await database(env).batch([
    compileD1Mutation(
      insert(schema.users, {
        id: userId,
        username,
        email,
        name,
        password_hash: passwordHash,
        system_role: "user",
        created_at: unixepoch(),
        updated_at: unixepoch(),
      }),
      { tag: "auth.users.register_from_invite" },
    ),
    compileD1Mutation(
      insert(schema.team_members, {
        team_id: publicToken.teamId,
        user_id: userId,
        role,
        site_ids_json: serializeMemberSiteIds(role === "member" ? siteIds : []),
        joined_at: unixepoch(),
      }),
      { tag: "auth.team_members.register_from_invite" },
    ),
    compileD1Mutation(
      update(schema.account_action_tokens, (columns) => ({
        set: {
          used_at: coalesce(columns.used_at, unixepoch()),
          used_by_user_id: coalesce(columns.used_by_user_id, param(userId)),
        },
        where: and(
          eq(columns.id, param(publicToken.id)),
          isNull(columns.used_at),
          isNull(columns.revoked_at),
        ),
      })),
      { tag: "auth.account_action_tokens.use_invite" },
    ),
  ]);

  const createdUser = await byId(env, userId);
  return ok(req, {
    type: "team_invite",
    team,
    user: createdUser ? toPublicUser(createdUser) : { id: userId },
    registered: true,
  });
}
