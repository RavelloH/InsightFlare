import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAccountLinksAdmin } from "@/lib/edge/admin/account-links";
import { byId, requireActor } from "@/lib/edge/admin/auth";
import { createAccountActionToken } from "@/lib/edge/auth/account-action-tokens";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/auth/account-action-tokens", () => ({
  createAccountActionToken: vi.fn(),
}));

vi.mock("@/lib/edge/admin/auth", () => ({
  byId: vi.fn(),
  requireActor: vi.fn(),
}));

const adminActor = {
  user: {
    id: "admin-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin",
    password_hash: "hash",
    system_role: "admin",
    timezone: "UTC",
    created_at: 1,
    updated_at: 2,
  },
  isAdmin: true,
};

const user = {
  id: "user-1",
  username: "user",
  email: "user@example.test",
  name: "User",
  password_hash: "hash",
  system_role: "user",
  timezone: "UTC",
  created_at: 1,
  updated_at: 2,
};

const requireActorMock = vi.mocked(requireActor);
const byIdMock = vi.mocked(byId);
const createAccountActionTokenMock = vi.mocked(createAccountActionToken);

function env(): Env {
  return { DB: {} as D1Database } as Env;
}

function request(body: Record<string, unknown>, method = "POST") {
  return new Request("https://app.test/api/private/admin/account-links", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("admin account links handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(adminActor);
    byIdMock.mockResolvedValue(user);
    createAccountActionTokenMock.mockResolvedValue({
      token: "plain-reset-token",
      record: {
        id: "token-1",
        type: "password_reset",
        teamId: "",
        userId: "user-1",
        email: "",
        payload: {},
        createdByUserId: "admin-1",
        createdAt: 1_700_000_000,
        expiresAt: 1_700_086_400,
        usedAt: null,
        usedByUserId: "",
        revokedAt: null,
        status: "active",
      },
    });
  });

  it("lets system admins generate password reset links", async () => {
    const response = await handleAccountLinksAdmin(
      request({ type: "password_reset", userId: "user-1" }),
      env(),
    );

    expect(response.status).toBe(200);
    await expect(jsonOf(response)).resolves.toMatchObject({
      ok: true,
      data: {
        url: "https://app.test/reset-password#token=plain-reset-token",
        expiresAt: 1_700_086_400,
      },
    });
    expect(createAccountActionTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "password_reset",
        userId: "user-1",
        createdByUserId: "admin-1",
        expiresAt: expect.any(Number),
      }),
    );
  });

  it("rejects non-admins and missing target users", async () => {
    requireActorMock.mockResolvedValueOnce({ ...adminActor, isAdmin: false });
    const forbidden = await handleAccountLinksAdmin(
      request({ type: "password_reset", userId: "user-1" }),
      env(),
    );
    expect(forbidden.status).toBe(403);

    byIdMock.mockResolvedValueOnce(null);
    const missing = await handleAccountLinksAdmin(
      request({ type: "password_reset", userId: "missing" }),
      env(),
    );
    expect(missing.status).toBe(404);
  });
});
