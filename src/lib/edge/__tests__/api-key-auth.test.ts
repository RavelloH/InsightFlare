import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API_KEY_USAGE_WRITE_INTERVAL_SECONDS,
  authenticateApiKey,
  canAccessSiteId,
  extractApiKeyToken,
  hasApiScope,
  hasFullSiteAccess,
  requireApiScope,
} from "@/lib/edge/auth/api-key-auth";
import {
  generateApiKeySecret,
  hashApiKeySecret,
} from "@/lib/edge/auth/api-key-store";
import type { Env } from "@/lib/edge/types";
afterEach(() => {
  vi.useRealTimers();
});
function createMockEnv(keyRow?: Record<string, unknown> | null) {
  return {
    MAIN_SECRET: "api-secret",
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(function (this: unknown) {
          return this;
        }),
        first: vi.fn(async () => keyRow ?? null),
        run: vi.fn(async () => ({ success: true })),
      })),
    } as unknown as D1Database,
  } as unknown as Env;
}
async function makeKey(overrides: Record<string, unknown> = {}) {
  const generated = generateApiKeySecret();
  const env = { MAIN_SECRET: "api-secret" } as Env;
  return {
    apiKey: generated.apiKey,
    row: {
      id: "key-1",
      team_id: "team-1",
      name: "CI",
      key_prefix: generated.prefix,
      key_hash: await hashApiKeySecret(env, generated.apiKey),
      scopes_json: '["site:read","analytics:read"]',
      site_ids_json: "[]",
      created_by_user_id: "user-1",
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: null,
      created_at: 100,
      updated_at: 100,
      ...overrides,
    },
  };
}
describe("extractApiKeyToken", () => {
  it("extracts token from Bearer header", () => {
    const req = new Request("https://test.example", {
      headers: { authorization: "Bearer ifk_live_prefix.secret" },
    });
    expect(extractApiKeyToken(req)).toBe("ifk_live_prefix.secret");
  });

  it("returns empty string for missing header", () => {
    const req = new Request("https://test.example");
    expect(extractApiKeyToken(req)).toBe("");
  });

  it("returns empty string for non-Bearer header", () => {
    const req = new Request("https://test.example", {
      headers: { authorization: "Basic abc" },
    });
    expect(extractApiKeyToken(req)).toBe("");
  });

  it("is case-insensitive for Bearer prefix", () => {
    const req = new Request("https://test.example", {
      headers: { authorization: "bearer ifk_live_prefix.secret" },
    });
    expect(extractApiKeyToken(req)).toBe("ifk_live_prefix.secret");
  });
});
describe("authenticateApiKey", () => {
  it("returns principal for valid key", async () => {
    const key = await makeKey();
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.keyId).toBe("key-1");
      expect(result.teamId).toBe("team-1");
      expect(result.scopes).toContain("site:read");
    }
  });

  it("uses ctx.waitUntil when provided", async () => {
    const key = await makeKey();
    const env = createMockEnv(key.row);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    await authenticateApiKey(req, env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("skips last-used writes for recently active keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));
    const lastUsedAt = Math.floor(Date.now() / 1000);
    const key = await makeKey({ last_used_at: lastUsedAt });
    const env = createMockEnv(key.row);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    await authenticateApiKey(req, env, ctx);

    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(env.DB.prepare).toHaveBeenCalledTimes(1);
  });

  it("refreshes last-used timestamps after the write interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));
    const lastUsedAt =
      Math.floor(Date.now() / 1000) - API_KEY_USAGE_WRITE_INTERVAL_SECONDS - 1;
    const key = await makeKey({ last_used_at: lastUsedAt });
    const env = createMockEnv(key.row);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    await authenticateApiKey(req, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for missing key", async () => {
    const env = createMockEnv();
    const req = new Request("https://test.example");
    const result = await authenticateApiKey(req, env);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(401);
  });

  it("returns 401 for key not found in DB", async () => {
    const key = await makeKey();
    const env = createMockEnv(null);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(401);
  });

  it("returns 401 for hash mismatch", async () => {
    const key = await makeKey({ key_hash: "wrong-hash" });
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(401);
  });

  it("returns 401 for revoked key", async () => {
    const key = await makeKey({ revoked_at: 100 });
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(401);
  });

  it("returns 401 for expired key", async () => {
    const key = await makeKey({ expires_at: 1 });
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(401);
  });

  it("handles invalid JSON in scopes_json and site_ids_json", async () => {
    const key = await makeKey({
      scopes_json: "not-json",
      site_ids_json: "not-json",
    });
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.scopes).toEqual([]);
      expect(result.siteIds).toEqual([]);
    }
  });

  it("treats valid non-array JSON permissions as empty", async () => {
    const key = await makeKey({
      scopes_json: '{"scope":"site:read"}',
      site_ids_json: '"site-1"',
    });
    const env = createMockEnv(key.row);
    const req = new Request("https://test.example", {
      headers: { authorization: `Bearer ${key.apiKey}` },
    });

    const result = await authenticateApiKey(req, env);
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.scopes).toEqual([]);
      expect(result.siteIds).toEqual([]);
    }
  });
});
describe("scope helpers", () => {
  const principal = {
    keyId: "k",
    teamId: "t",
    prefix: "p",
    scopes: ["site:read" as const, "analytics:read" as const],
    siteIds: [] as string[],
  };

  it("hasApiScope checks scope presence", () => {
    expect(hasApiScope(principal, "site:read")).toBe(true);
    expect(hasApiScope(principal, "site:write")).toBe(false);
  });

  it("hasFullSiteAccess returns true when siteIds is empty", () => {
    expect(hasFullSiteAccess(principal)).toBe(true);
  });

  it("canAccessSiteId checks site access", () => {
    expect(canAccessSiteId(principal, "any-site")).toBe(true);
    const restricted = { ...principal, siteIds: ["site-1"] };
    expect(canAccessSiteId(restricted, "site-1")).toBe(true);
    expect(canAccessSiteId(restricted, "site-2")).toBe(false);
  });

  it("requireApiScope returns null when scope present", () => {
    expect(requireApiScope(principal, "site:read")).toBeNull();
  });

  it("requireApiScope returns 403 response when scope missing", () => {
    const result = requireApiScope(principal, "site:write");
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(403);
  });
});
