import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  byId,
  byIdentifier,
  hashPassword,
  normE,
  normU,
  toPublicUser,
} from "@/lib/edge/admin/auth";
import {
  getValidAccountActionToken,
  markAccountActionTokenUsed,
  toPublicAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import { handlePublicAccountLinks } from "@/lib/edge/auth/public-account-links";
import { requireSession } from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/edge/auth/account-action-tokens", () => ({
  getValidAccountActionToken: vi.fn(),
  markAccountActionTokenUsed: vi.fn(),
  toPublicAccountActionToken: vi.fn((row: TokenRow) => ({
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
    status: "active",
  })),
}));
vi.mock("@/lib/edge/admin/auth", () => ({
  byId: vi.fn(),
  byIdentifier: vi.fn(),
  hashPassword: vi.fn(),
  normE: (value: string) => value.trim().toLowerCase().slice(0, 200),
  normU: (value: string) => value.trim().toLowerCase().slice(0, 80),
  toPublicUser: vi.fn((user: UserRow) => ({
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name || "",
    systemRole: user.system_role === "admin" ? "admin" : "user",
  })),
}));
vi.mock("@/lib/edge/auth/session-auth", () => ({
  requireSession: vi.fn(),
}));
interface TokenRow {
  id: string;
  type: "team_invite" | "password_reset";
  token_hash: string;
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
}
interface UserRow {
  id: string;
  username: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  system_role: string;
  timezone: string;
  created_at: number;
  updated_at: number;
}
interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}
const teamInviteRow: TokenRow = {
  id: "invite-1",
  type: "team_invite",
  token_hash: "hash",
  team_id: "team-1",
  user_id: null,
  email: "friend@example.test",
  payload_json: JSON.stringify({
    teamRole: "admin",
    allowRegistration: false,
    siteAccess: { mode: "all" },
  }),
  created_by_user_id: "actor-1",
  created_at: 10,
  expires_at: 20,
  used_at: null,
  used_by_user_id: null,
  revoked_at: null,
};
const resetRow: TokenRow = {
  ...teamInviteRow,
  id: "reset-1",
  type: "password_reset",
  team_id: null,
  user_id: "user-1",
  email: null,
  payload_json: "{}",
};
const user: UserRow = {
  id: "user-1",
  username: "friend",
  email: "friend@example.test",
  name: "Friend",
  password_hash: "old-hash",
  system_role: "user",
  timezone: "UTC",
  created_at: 1,
  updated_at: 2,
};
const getValidAccountActionTokenMock = vi.mocked(getValidAccountActionToken);
const markAccountActionTokenUsedMock = vi.mocked(markAccountActionTokenUsed);
const byIdMock = vi.mocked(byId);
const byIdentifierMock = vi.mocked(byIdentifier);
const hashPasswordMock = vi.mocked(hashPassword);
const requireSessionMock = vi.mocked(requireSession);
function statement(first: unknown = null): MockStatement {
  const stmt = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn().mockResolvedValue(first),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return stmt;
}
function createEnv(statements: MockStatement[] = []) {
  let index = 0;
  const prepare = vi.fn(() => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) throw new Error(`Unexpected SQL #${index}`);
    return stmt;
  });
  const batch = vi.fn().mockResolvedValue([]);
  return {
    env: { DB: { prepare, batch } as unknown as D1Database } as Env,
    prepare,
    batch,
  };
}
function request(path: string, body: Record<string, unknown>) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
describe("public account link handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValidAccountActionTokenMock.mockResolvedValue(teamInviteRow);
    markAccountActionTokenUsedMock.mockResolvedValue(teamInviteRow);
    byIdMock.mockResolvedValue(user);
    byIdentifierMock.mockResolvedValue(null);
    hashPasswordMock.mockResolvedValue("new-hash");
    requireSessionMock.mockResolvedValue(null);
  });

  it("inspects team invites without caching or exposing token hashes", async () => {
    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/inspect", { token: "plain-token" }),
      createEnv([statement({ id: "team-1", name: "Team", slug: "team" })]).env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await jsonOf(response);
    expect(payload).toMatchObject({
      ok: true,
      data: {
        type: "team_invite",
        team: { id: "team-1", name: "Team", slug: "team" },
        requiresLogin: true,
        allowsRegistration: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("hash");
    expect(toPublicAccountActionToken).toHaveBeenCalledWith(teamInviteRow);
  });

  it("rejects malformed public account link requests", async () => {
    const env = createEnv().env;

    const wrongMethod = await handlePublicAccountLinks(
      new Request("https://app.test/api/public/account-links/inspect", {
        method: "GET",
      }),
      env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("cache-control")).toBe("no-store");

    const unknownAction = await handlePublicAccountLinks(
      request("/api/public/account-links/unknown", { token: "plain-token" }),
      env,
      new URL("https://app.test/api/public/account-links/unknown"),
    );
    await expect(jsonOf(unknownAction)).resolves.toMatchObject({
      ok: false,
      error: "Not Found",
    });

    const missingToken = await handlePublicAccountLinks(
      request("/api/public/account-links/inspect", { token: "   " }),
      env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );
    await expect(jsonOf(missingToken)).resolves.toMatchObject({
      ok: false,
      error: "token is required",
    });

    getValidAccountActionTokenMock.mockResolvedValueOnce(null);
    const expired = await handlePublicAccountLinks(
      request("/api/public/account-links/inspect", { token: "expired" }),
      env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );
    await expect(jsonOf(expired)).resolves.toMatchObject({
      ok: false,
      error: "Invalid or expired link",
    });
  });

  it("inspects password reset links with masked account details", async () => {
    getValidAccountActionTokenMock.mockResolvedValue(resetRow);

    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/inspect", { token: "plain-token" }),
      createEnv().env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );

    expect(response.status).toBe(200);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: true,
      data: {
        type: "password_reset",
        user: {
          username: "friend",
          email: "fr****@example.test",
        },
      },
    });
  });

  it("rejects invite inspection when the team is missing", async () => {
    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/inspect", { token: "plain-token" }),
      createEnv([statement(null)]).env,
      new URL("https://app.test/api/public/account-links/inspect"),
    );

    expect(response.status).toBe(404);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: false,
      error: "Team not found",
    });
  });

  it("lets a signed-in matching user accept a team invite", async () => {
    requireSessionMock.mockResolvedValue({ userId: "user-1" } as Awaited<
      ReturnType<typeof requireSession>
    >);
    const insertMember = statement();
    const { env } = createEnv([
      statement({ id: "team-1", name: "Team", slug: "team" }),
      insertMember,
      statement({ id: "team-1", name: "Team", slug: "team" }),
    ]);

    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", { token: "plain-token" }),
      env,
      new URL("https://app.test/api/public/account-links/complete"),
    );

    expect(response.status).toBe(200);
    expect(insertMember.bind).toHaveBeenCalledWith(
      "team-1",
      "user-1",
      "admin",
      "[]",
    );
    expect(markAccountActionTokenUsedMock).toHaveBeenCalledWith(
      expect.anything(),
      { tokenId: "invite-1", usedByUserId: "user-1" },
    );
  });

  it("rejects signed-in users whose email does not match the invite", async () => {
    requireSessionMock.mockResolvedValue({ userId: "user-1" } as Awaited<
      ReturnType<typeof requireSession>
    >);
    byIdMock.mockResolvedValue({
      ...user,
      email: "other@example.test",
    });

    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", { token: "plain-token" }),
      createEnv([statement({ id: "team-1", name: "Team", slug: "team" })]).env,
      new URL("https://app.test/api/public/account-links/complete"),
    );

    expect(response.status).toBe(403);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: false,
      error: "Invite email does not match the signed-in user",
    });
  });

  it("rejects invite registration when registration is disabled", async () => {
    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", { token: "plain-token" }),
      createEnv([statement({ id: "team-1", name: "Team", slug: "team" })]).env,
      new URL("https://app.test/api/public/account-links/complete"),
    );

    expect(response.status).toBe(403);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: false,
      error: "This invite requires an existing account",
    });
  });

  it("registers a new invited user without creating a personal team", async () => {
    getValidAccountActionTokenMock.mockResolvedValue({
      ...teamInviteRow,
      email: null,
      payload_json: JSON.stringify({ teamRole: "member" }),
    });
    const insertUser = statement();
    const insertMember = statement();
    const markUsed = statement();
    const { env, batch } = createEnv([
      statement({ id: "team-1", name: "Team", slug: "team" }),
      insertUser,
      insertMember,
      markUsed,
    ]);
    byIdMock.mockResolvedValueOnce({
      ...user,
      id: "00000000-0000-4000-8000-000000000123",
      username: "new-user",
      email: "new@example.test",
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000123",
    );

    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", {
        token: "plain-token",
        username: "new-user",
        email: "new@example.test",
        name: "New User",
        password: "secret-password",
      }),
      env,
      new URL("https://app.test/api/public/account-links/complete"),
    );

    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(insertUser.bind).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000123",
      "new-user",
      "new@example.test",
      "New User",
      "new-hash",
    );
    expect(insertMember.bind).toHaveBeenCalledWith(
      "team-1",
      "00000000-0000-4000-8000-000000000123",
      "member",
      "[]",
    );
  });

  it("completes password reset links", async () => {
    getValidAccountActionTokenMock.mockResolvedValue(resetRow);
    const updatePassword = statement();

    const response = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", {
        token: "plain-token",
        password: "new-password",
      }),
      createEnv([updatePassword]).env,
      new URL("https://app.test/api/public/account-links/complete"),
    );

    expect(response.status).toBe(200);
    expect(updatePassword.bind).toHaveBeenCalledWith("new-hash", "user-1");
    expect(markAccountActionTokenUsedMock).toHaveBeenCalledWith(
      expect.anything(),
      { tokenId: "reset-1", usedByUserId: "user-1" },
    );
    expect(normE(" Friend@Example.Test ")).toBe("friend@example.test");
    expect(normU(" New_User ")).toBe("new_user");
    expect(toPublicUser).toBeDefined();
  });

  it("rejects invalid password reset completions", async () => {
    getValidAccountActionTokenMock.mockResolvedValue(resetRow);

    const shortPassword = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", {
        token: "plain-token",
        password: "short",
      }),
      createEnv().env,
      new URL("https://app.test/api/public/account-links/complete"),
    );
    expect(shortPassword.status).toBe(400);
    await expect(jsonOf(shortPassword)).resolves.toMatchObject({
      ok: false,
      error: "Password must be at least 8 characters",
    });

    getValidAccountActionTokenMock.mockResolvedValue({
      ...resetRow,
      user_id: null,
    });
    const missingUser = await handlePublicAccountLinks(
      request("/api/public/account-links/complete", {
        token: "plain-token",
        password: "new-password",
      }),
      createEnv().env,
      new URL("https://app.test/api/public/account-links/complete"),
    );
    expect(missingUser.status).toBe(404);
    await expect(jsonOf(missingUser)).resolves.toMatchObject({
      ok: false,
      error: "User not found",
    });
  });
});
