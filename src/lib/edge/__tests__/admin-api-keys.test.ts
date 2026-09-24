import { beforeEach, describe, expect, it, vi } from "vitest";

import { canManageTeam } from "@/lib/edge/admin/access";
import { handleApiKeysAdmin } from "@/lib/edge/admin/api-keys/handler";
import { requireActor } from "@/lib/edge/admin/auth";
import {
  createApiKeyRecord,
  getApiKeyById,
  listApiKeys,
  revokeApiKeyRecord,
} from "@/lib/edge/auth/api-key-store";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/edge/admin/auth", () => ({
  requireActor: vi.fn(),
}));
vi.mock("@/lib/edge/admin/access", () => ({
  canManageTeam: vi.fn(),
}));
vi.mock("@/lib/edge/auth/api-key-store", async () => {
  const actual = await vi.importActual("@/lib/edge/auth/api-key-store");
  return {
    ...(actual as Record<string, unknown>),
    createApiKeyRecord: vi.fn(),
    getApiKeyById: vi.fn(),
    listApiKeys: vi.fn(),
    revokeApiKeyRecord: vi.fn(),
  };
});
const requireActorMock = vi.mocked(requireActor);
const canManageTeamMock = vi.mocked(canManageTeam);
const listApiKeysMock = vi.mocked(listApiKeys);
const createApiKeyRecordMock = vi.mocked(createApiKeyRecord);
const getApiKeyByIdMock = vi.mocked(getApiKeyById);
const revokeApiKeyRecordMock = vi.mocked(revokeApiKeyRecord);
const actor = {
  user: {
    id: "user-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin",
    password_hash: null,
    system_role: "user",
    timezone: "UTC",
    created_at: 1,
    updated_at: 1,
  },
  isAdmin: false,
};
const env = {
  DB: {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      all: vi.fn(async () => ({ results: [] })),
    })),
  } as unknown as D1Database,
} as Env;
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://edge.test${path}`, init);
}
describe("api key admin handler", () => {
  beforeEach(() => {
    requireActorMock.mockReset();
    canManageTeamMock.mockReset();
    listApiKeysMock.mockReset();
    createApiKeyRecordMock.mockReset();
    getApiKeyByIdMock.mockReset();
    revokeApiKeyRecordMock.mockReset();
    requireActorMock.mockResolvedValue(actor);
    canManageTeamMock.mockResolvedValue(true);
    listApiKeysMock.mockResolvedValue([]);
    createApiKeyRecordMock.mockResolvedValue({
      key: {
        id: "key-1",
        teamId: "team-1",
        name: "CI",
        prefix: "prefix",
        scopes: ["site:read"],
        siteIds: [],
        createdByUserId: "user-1",
        expiresAt: null,
        revokedAt: null,
        revokedByUserId: "",
        rotatedFromKeyId: "",
        lastUsedAt: null,
        createdAt: 1,
        updatedAt: 1,
        status: "active",
      },
      secret: "ifk_live_prefix.secret",
    });
    getApiKeyByIdMock.mockResolvedValue({
      id: "key-1",
      team_id: "team-1",
      name: "CI",
      key_prefix: "prefix",
      key_hash: "hash",
      scopes_json: '["site:read"]',
      site_ids_json: "[]",
      created_by_user_id: "user-1",
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
    });
  });

  // ─── Auth ────────────────────────────────────────────────────────

  it("returns 401 when actor is not authenticated", async () => {
    requireActorMock.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys?teamId=team-1"),
      env,
      new URL("https://edge.test/api/private/admin/api-keys?teamId=team-1"),
    );
    expect(response.status).toBe(401);
  });

  // ─── GET ─────────────────────────────────────────────────────────

  it("requires team management permission", async () => {
    canManageTeamMock.mockResolvedValue(false);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys?teamId=team-1"),
      env,
      new URL("https://edge.test/api/private/admin/api-keys?teamId=team-1"),
    );

    expect(response.status).toBe(403);
  });

  it("lists keys for a manageable team", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys?teamId=team-1"),
      env,
      new URL("https://edge.test/api/private/admin/api-keys?teamId=team-1"),
    );

    expect(response.status).toBe(200);
    expect(listApiKeysMock).toHaveBeenCalledWith(env, "team-1");
  });

  it("returns 400 for GET without teamId", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys"),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  // ─── POST ────────────────────────────────────────────────────────

  it("creates a key and returns the one-time secret", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          teamId: "team-1",
          name: "CI",
          scopes: ["site:read"],
          siteIds: [],
          expiresInDays: "never",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { secret: string } };
    expect(payload.data.secret).toBe("ifk_live_prefix.secret");
    expect(createApiKeyRecordMock).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        teamId: "team-1",
        name: "CI",
        scopes: ["site:read"],
        createdByUserId: "user-1",
        expiresAt: null,
      }),
    );
  });

  it("returns 400 for POST without teamId", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: "CI", scopes: ["site:read"] }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for POST with short name", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          teamId: "team-1",
          name: "A",
          scopes: ["site:read"],
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for POST with no scopes", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          teamId: "team-1",
          name: "CI",
          scopes: [],
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 403 when team is not manageable on POST", async () => {
    canManageTeamMock.mockResolvedValue(false);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          teamId: "team-1",
          name: "CI",
          scopes: ["site:read"],
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(403);
  });

  // ─── PATCH ───────────────────────────────────────────────────────

  it("revokes keys by intent", async () => {
    revokeApiKeyRecordMock.mockResolvedValue(null);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "key-1",
          intent: "revoke",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(200);
    expect(revokeApiKeyRecordMock).toHaveBeenCalledWith(env, {
      teamId: "team-1",
      keyId: "key-1",
      revokedByUserId: "user-1",
    });
  });

  it("rotates keys by intent", async () => {
    revokeApiKeyRecordMock.mockResolvedValue(null);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "key-1",
          intent: "rotate",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(200);
    expect(createApiKeyRecordMock).toHaveBeenCalled();
    expect(revokeApiKeyRecordMock).toHaveBeenCalled();
  });

  it("returns 400 for unsupported PATCH intent", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "key-1",
          intent: "invalid",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for PATCH without teamId or keyId", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({ intent: "revoke" }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when key not found on PATCH", async () => {
    getApiKeyByIdMock.mockResolvedValue(null);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "missing",
          intent: "revoke",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 when key belongs to different team", async () => {
    getApiKeyByIdMock.mockResolvedValue({
      id: "key-1",
      team_id: "other-team",
      name: "CI",
      key_prefix: "prefix",
      key_hash: "hash",
      scopes_json: "[]",
      site_ids_json: "[]",
      created_by_user_id: "user-1",
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
    });
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "key-1",
          intent: "revoke",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(404);
  });

  it("returns 403 when team is not manageable on PATCH", async () => {
    canManageTeamMock.mockResolvedValue(false);
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", {
        method: "PATCH",
        body: JSON.stringify({
          teamId: "team-1",
          keyId: "key-1",
          intent: "revoke",
        }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(403);
  });

  // ─── Unsupported method ──────────────────────────────────────────

  it("returns 405 for unsupported methods", async () => {
    const response = await handleApiKeysAdmin(
      request("/api/private/admin/api-keys", { method: "DELETE" }),
      env,
      new URL("https://edge.test/api/private/admin/api-keys"),
    );

    expect(response.status).toBe(405);
  });
});
