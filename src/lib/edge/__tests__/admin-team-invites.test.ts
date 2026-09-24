import { beforeEach, describe, expect, it, vi } from "vitest";

import { canManageTeam, teamById } from "@/lib/edge/admin/access";
import { requireActor } from "@/lib/edge/admin/auth";
import { handleTeamInvitesAdmin } from "@/lib/edge/admin/teams/invites";
import {
  createAccountActionToken,
  getAccountActionTokenById,
  listTeamInviteTokens,
  revokeAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import {
  decryptTeamInviteToken,
  encryptTeamInviteToken,
} from "@/lib/edge/auth/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/edge/auth/account-action-tokens", () => ({
  createAccountActionToken: vi.fn(),
  getAccountActionTokenById: vi.fn(),
  listTeamInviteTokens: vi.fn(),
  revokeAccountActionToken: vi.fn(),
  toPublicAccountActionToken: (row: {
    id: string;
    type: string;
    team_id: string | null;
    user_id: string | null;
    email: string | null;
    payload_json: string;
    created_by_user_id: string | null;
    created_at: number;
    expires_at: number;
    used_at: number | null;
    used_by_user_id: string | null;
    revoked_at: number | null;
  }) => ({
    id: row.id,
    type: row.type,
    teamId: row.team_id || "",
    userId: row.user_id || "",
    email: row.email || "",
    payload: JSON.parse(row.payload_json || "{}") as Record<string, unknown>,
    createdByUserId: row.created_by_user_id || "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedByUserId: row.used_by_user_id || "",
    revokedAt: row.revoked_at,
    status: row.revoked_at ? "revoked" : row.used_at ? "used" : "active",
  }),
}));
vi.mock("@/lib/edge/admin/access", () => ({
  canManageTeam: vi.fn(),
  teamById: vi.fn(),
}));
vi.mock("@/lib/edge/admin/auth", () => ({
  requireActor: vi.fn(),
}));
vi.mock("@/lib/edge/system-config", () => ({
  readConfig: vi.fn(),
}));
vi.mock("@/lib/edge/auth/secret-encryption", () => ({
  decryptTeamInviteToken: vi.fn(async (_env: Env, encrypted: string) =>
    encrypted.replace(/^encrypted:/, ""),
  ),
  encryptTeamInviteToken: vi.fn(
    async (_env: Env, token: string) => `encrypted:${token}`,
  ),
}));
const actor = {
  user: {
    id: "actor-1",
    username: "actor",
    email: "actor@example.test",
    name: "Actor",
    password_hash: "hash",
    system_role: "user",
    timezone: "UTC",
    created_at: 1,
    updated_at: 2,
  },
  isAdmin: false,
};
const inviteRecord = {
  id: "invite-1",
  type: "team_invite" as const,
  teamId: "team-1",
  userId: "",
  email: "friend@example.test",
  payload: {
    teamRole: "member",
    siteAccess: { mode: "all" },
    tokenEncrypted: "encrypted:plain-token",
  },
  createdByUserId: "actor-1",
  createdAt: 10,
  expiresAt: 20,
  usedAt: null,
  usedByUserId: "",
  revokedAt: null,
  status: "active" as const,
};
const inviteRow = {
  id: "invite-1",
  type: "team_invite",
  token_hash: "stored-hash",
  team_id: "team-1",
  user_id: null,
  email: "friend@example.test",
  payload_json: JSON.stringify({ teamRole: "member" }),
  created_by_user_id: "actor-1",
  created_at: 10,
  expires_at: 20,
  used_at: null,
  used_by_user_id: null,
  revoked_at: null,
};
const requireActorMock = vi.mocked(requireActor);
const canManageTeamMock = vi.mocked(canManageTeam);
const teamByIdMock = vi.mocked(teamById);
const readConfigMock = vi.mocked(readConfig);
const createAccountActionTokenMock = vi.mocked(createAccountActionToken);
const listTeamInviteTokensMock = vi.mocked(listTeamInviteTokens);
const getAccountActionTokenByIdMock = vi.mocked(getAccountActionTokenById);
const revokeAccountActionTokenMock = vi.mocked(revokeAccountActionToken);
const decryptTeamInviteTokenMock = vi.mocked(decryptTeamInviteToken);
const encryptTeamInviteTokenMock = vi.mocked(encryptTeamInviteToken);
function env(): Env {
  return { DB: {} as D1Database } as Env;
}
function request(path: string, init?: RequestInit) {
  return new Request(`https://app.example.test${path}`, init);
}
function jsonInit(body: unknown, method: "POST" | "PATCH" = "POST") {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
describe("team invite admin handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(actor);
    canManageTeamMock.mockResolvedValue(true);
    teamByIdMock.mockResolvedValue({ id: "team-1", ownerUserId: "actor-1" });
    readConfigMock.mockResolvedValue(null);
    createAccountActionTokenMock.mockResolvedValue({
      token: "plain-token",
      record: inviteRecord,
    });
    listTeamInviteTokensMock.mockResolvedValue([inviteRecord]);
    getAccountActionTokenByIdMock.mockResolvedValue(inviteRow);
    revokeAccountActionTokenMock.mockResolvedValue({
      ...inviteRow,
      revoked_at: 11,
    });
  });

  it("creates a team invite link without exposing token in the invite record", async () => {
    const response = await handleTeamInvitesAdmin(
      request(
        "/api/private/admin/team-invites",
        jsonInit({
          teamId: "team-1",
          email: "Friend@Example.Test",
          role: "admin",
          expiresInHours: 12,
        }),
      ),
      env(),
      new URL("https://app.example.test/api/private/admin/team-invites"),
    );

    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        invite: {
          id: "invite-1",
          email: "friend@example.test",
          code: "plain-token",
          url: "https://app.example.test/invite#token=plain-token",
        },
        url: "https://app.example.test/invite#token=plain-token",
      },
    });
    expect(JSON.stringify(payload.data)).not.toContain("stored-hash");
    expect(JSON.stringify(payload.data)).not.toContain("encrypted:");
    expect(encryptTeamInviteTokenMock).not.toHaveBeenCalled();
    expect(createAccountActionTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "team_invite",
        teamId: "team-1",
        email: "friend@example.test",
        tokenPayload: expect.any(Function),
      }),
    );
    const createInput = createAccountActionTokenMock.mock.calls[0]?.[1];
    const payloadFromToken = await createInput?.tokenPayload?.("created-token");
    expect(payloadFromToken).toMatchObject({
      teamRole: "admin",
      allowRegistration: true,
      tokenEncrypted: "encrypted:created-token",
    });
    expect(encryptTeamInviteTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      "created-token",
    );
  });

  it("lists team invites for team admins with copyable invite urls", async () => {
    const response = await handleTeamInvitesAdmin(
      request("/api/private/admin/team-invites?teamId=team-1", {
        method: "GET",
      }),
      env(),
      new URL(
        "https://app.example.test/api/private/admin/team-invites?teamId=team-1",
      ),
    );

    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    expect(payload).toMatchObject({
      ok: true,
      data: [
        {
          id: "invite-1",
          status: "active",
          code: "plain-token",
          url: "https://app.example.test/invite#token=plain-token",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("encrypted:");
    expect(decryptTeamInviteTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      "encrypted:plain-token",
    );
    expect(listTeamInviteTokensMock).toHaveBeenCalledWith(
      expect.anything(),
      "team-1",
    );
  });

  it("rejects unsupported roles and users without team management access", async () => {
    const invalidRole = await handleTeamInvitesAdmin(
      request(
        "/api/private/admin/team-invites",
        jsonInit({ teamId: "team-1", role: "owner" }),
      ),
      env(),
      new URL("https://app.example.test/api/private/admin/team-invites"),
    );
    expect(invalidRole.status).toBe(400);

    canManageTeamMock.mockResolvedValueOnce(false);
    const forbidden = await handleTeamInvitesAdmin(
      request("/api/private/admin/team-invites?teamId=team-1", {
        method: "GET",
      }),
      env(),
      new URL(
        "https://app.example.test/api/private/admin/team-invites?teamId=team-1",
      ),
    );
    expect(forbidden.status).toBe(403);
  });

  it("revokes invites idempotently for matching teams", async () => {
    const response = await handleTeamInvitesAdmin(
      request(
        "/api/private/admin/team-invites",
        jsonInit(
          { teamId: "team-1", inviteId: "invite-1", intent: "revoke" },
          "PATCH",
        ),
      ),
      env(),
      new URL("https://app.example.test/api/private/admin/team-invites"),
    );

    expect(response.status).toBe(200);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: true,
      data: { id: "invite-1", status: "revoked", revokedAt: 11 },
    });
    expect(revokeAccountActionTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      { tokenId: "invite-1" },
    );
  });
});
