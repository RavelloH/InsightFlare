import { canManageTeam, teamById } from "@/lib/edge/admin/access";
import { requireActor } from "@/lib/edge/admin/auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "@/lib/edge/admin/response";
import {
  createAccountActionToken,
  getAccountActionTokenById,
  listTeamInviteTokens,
  revokeAccountActionToken,
  toPublicAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import {
  assertSitesBelongToTeam,
  normalizeMemberSiteIds,
} from "@/lib/edge/auth/member-site-access";
import {
  decryptTeamInviteToken,
  encryptTeamInviteToken,
} from "@/lib/edge/auth/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";
import { clampString, nowEpochSeconds } from "@/lib/edge/utils";
const TEAM_INVITES_CONFIG_KEY = "system:team_invites";
const DEFAULT_INVITE_EXPIRES_IN_HOURS = 72;
const MAX_INVITE_EXPIRES_IN_HOURS = 24 * 30;
type InviteRole = "member" | "admin";
interface TeamInvitesConfig {
  enabled: boolean;
  allowTeamAdminCreateUsers: boolean;
  defaultInviteExpiresInHours: number;
}
function toInviteRole(input: unknown): InviteRole | null {
  const role = String(input || "member").toLowerCase();
  return role === "member" || role === "admin" ? role : null;
}
function toPositiveHours(input: unknown, fallback: number): number {
  const numeric = Number(input);
  const value = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(1, Math.min(MAX_INVITE_EXPIRES_IN_HOURS, Math.floor(value)));
}
function normalizeInviteEmail(input: unknown): string {
  return clampString(
    String(input || "")
      .trim()
      .toLowerCase(),
    200,
  );
}
function isValidEmail(input: string): boolean {
  if (!input) return true;
  return input.length >= 3 && input.includes("@");
}
function inviteUrl(req: Request, token: string): string {
  const url = new URL(req.url);
  return `${url.origin}/invite#token=${encodeURIComponent(token)}`;
}
function inviteCodeFromToken(token: string): string {
  return token;
}
function publicPayload(payload: Record<string, unknown>) {
  const safePayload = { ...payload };
  delete safePayload.tokenEncrypted;
  return safePayload;
}
async function encryptedInviteTokenPayload(
  env: Env,
  token: string,
): Promise<Record<string, unknown>> {
  try {
    return { tokenEncrypted: await encryptTeamInviteToken(env, token) };
  } catch {
    return {};
  }
}
async function withInviteUrls(
  req: Request,
  env: Env,
  invites: Awaited<ReturnType<typeof listTeamInviteTokens>>,
) {
  return Promise.all(
    invites.map(async (invite) => {
      const baseInvite = {
        ...invite,
        payload: publicPayload(invite.payload),
      };
      const encrypted =
        typeof invite.payload.tokenEncrypted === "string"
          ? invite.payload.tokenEncrypted
          : "";
      if (!encrypted) return baseInvite;
      try {
        const token = await decryptTeamInviteToken(env, encrypted);
        return {
          ...baseInvite,
          code: inviteCodeFromToken(token),
          url: inviteUrl(req, token),
        };
      } catch {
        return baseInvite;
      }
    }),
  );
}
async function readTeamInvitesConfig(env: Env): Promise<TeamInvitesConfig> {
  const config = (await readConfig(env, TEAM_INVITES_CONFIG_KEY)) ?? {};
  return {
    enabled: config.enabled !== false,
    allowTeamAdminCreateUsers: config.allowTeamAdminCreateUsers !== false,
    defaultInviteExpiresInHours: toPositiveHours(
      config.defaultInviteExpiresInHours,
      DEFAULT_INVITE_EXPIRES_IN_HOURS,
    ),
  };
}
export async function handleTeamInvitesAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;

  if (req.method === "GET") {
    const teamId = clampString(
      String(url.searchParams.get("teamId") || ""),
      120,
    );
    if (!teamId) return bad("teamId is required", undefined, req);
    if (!(await canManageTeam(env, actor, teamId))) {
      return forb("Only team admins can manage invites", undefined, req);
    }
    if (!(await teamById(env, teamId))) {
      return nf("Team not found", undefined, req);
    }
    return jsonResponseFor(req, {
      ok: true,
      data: await withInviteUrls(
        req,
        env,
        await listTeamInviteTokens(env, teamId),
      ),
    });
  }

  if (req.method === "POST") {
    const config = await readTeamInvitesConfig(env);
    if (!config.enabled) {
      return forb("Team invites are disabled", undefined, req);
    }

    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    if (!teamId) return bad("teamId is required", undefined, req);
    if (!(await canManageTeam(env, actor, teamId))) {
      return forb("Only team admins can create invites", undefined, req);
    }
    if (!(await teamById(env, teamId))) {
      return nf("Team not found", undefined, req);
    }

    const role = toInviteRole(body.role);
    if (!role) {
      return bad("Invite role must be member or admin", undefined, req);
    }

    const email = normalizeInviteEmail(body.email);
    if (!isValidEmail(email)) {
      return bad("A valid email is required", undefined, req);
    }

    const siteIds =
      role === "member" ? normalizeMemberSiteIds(body.siteIds) : [];
    if (!(await assertSitesBelongToTeam(env, teamId, siteIds))) {
      return bad("siteIds must belong to the team", undefined, req);
    }

    const expiresInHours = toPositiveHours(
      body.expiresInHours,
      config.defaultInviteExpiresInHours,
    );
    const created = await createAccountActionToken(env, {
      type: "team_invite",
      teamId,
      email: email || null,
      tokenPayload: async (token) => ({
        teamRole: role,
        siteIds,
        allowRegistration: actor.isAdmin || config.allowTeamAdminCreateUsers,
        ...(await encryptedInviteTokenPayload(env, token)),
      }),
      createdByUserId: actor.user.id,
      expiresAt: nowEpochSeconds() + expiresInHours * 60 * 60,
    });

    return jsonResponseFor(req, {
      ok: true,
      data: {
        invite: {
          ...created.record,
          payload: publicPayload(created.record.payload),
          code: inviteCodeFromToken(created.token),
          url: inviteUrl(req, created.token),
        },
        url: inviteUrl(req, created.token),
      },
    });
  }

  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(String(body.intent || ""), 24).toLowerCase();
    const teamId = clampString(String(body.teamId || ""), 120);
    const inviteId = clampString(String(body.inviteId || ""), 120);
    if (intent !== "revoke") {
      return bad("Unsupported invite action", undefined, req);
    }
    if (!teamId) return bad("teamId is required", undefined, req);
    if (!inviteId) return bad("inviteId is required", undefined, req);
    if (!(await canManageTeam(env, actor, teamId))) {
      return forb("Only team admins can revoke invites", undefined, req);
    }

    const existing = await getAccountActionTokenById(env, inviteId);
    if (!existing || existing.type !== "team_invite") {
      return nf("Invite not found", undefined, req);
    }
    if (existing.team_id !== teamId) {
      return nf("Invite not found", undefined, req);
    }

    const revoked = await revokeAccountActionToken(env, { tokenId: inviteId });
    return jsonResponseFor(req, {
      ok: true,
      data: revoked
        ? toPublicAccountActionToken(revoked)
        : toPublicAccountActionToken(existing),
    });
  }

  return na(req);
}
