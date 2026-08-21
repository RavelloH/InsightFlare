import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ApiKeyRow,
  apiKeyStatus,
  createApiKeyRecord,
  expiresAtFromDays,
  generateApiKeySecret,
  getApiKeyById,
  getApiKeyByPrefix,
  hashApiKeySecret,
  listApiKeys,
  markApiKeyUsed,
  normalizeApiKeyScopes,
  normalizeApiKeySiteIds,
  parseApiKey,
  revokeApiKeyRecord,
  serializeScopes,
  serializeSiteIds,
  timingSafeEqualString,
  toPublicApiKey,
} from "@/lib/edge/api-key-store";
import type { Env } from "@/lib/edge/types";

function createMockEnv(
  matchFirst?: ApiKeyRow | Record<string, unknown> | null,
  matchAll?: Array<ApiKeyRow | Record<string, unknown>>,
) {
  return {
    MAIN_SECRET: "api-key-secret",
    DB: {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          sql,
          bind: vi.fn(function (this: typeof stmt) {
            return this;
          }),
          first: vi.fn(async () => matchFirst ?? null),
          all: vi.fn(async () => ({ results: matchAll ?? [] })),
          run: vi.fn(async () => ({ success: true })),
        };
        return stmt;
      }),
    } as unknown as D1Database,
  } as unknown as Env;
}

function makeRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    team_id: "team-1",
    name: "CI",
    key_prefix: "prefix123",
    key_hash: "hash",
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
  };
}

describe("api key store utilities", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("generates and parses live API keys", () => {
    const generated = generateApiKeySecret();

    expect(generated.apiKey).toMatch(
      /^ifk_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(parseApiKey(generated.apiKey)).toEqual({
      prefix: generated.prefix,
    });
    expect(parseApiKey("not-a-key")).toBeNull();
  });

  it("rejects keys with missing dot separator", () => {
    expect(parseApiKey("ifk_live_nodot")).toBeNull();
  });

  it("rejects keys with empty prefix or secret", () => {
    expect(parseApiKey("ifk_live_.secret")).toBeNull();
    expect(parseApiKey("ifk_live_prefix.")).toBeNull();
  });

  it("rejects keys with invalid prefix characters", () => {
    expect(parseApiKey("ifk_live_!!!.secret")).toBeNull();
  });

  it("hashes API keys with HMAC and compares strings safely", async () => {
    const env = { MAIN_SECRET: "api-key-secret" } as Env;
    const left = await hashApiKeySecret(env, "ifk_live_prefix.secret");
    const right = await hashApiKeySecret(env, "ifk_live_prefix.secret");
    const other = await hashApiKeySecret(env, "ifk_live_prefix.other");

    expect(left).toBe(right);
    expect(left).not.toBe(other);
    expect(timingSafeEqualString(left, right)).toBe(true);
    expect(timingSafeEqualString(left, other)).toBe(false);
  });

  it("reuses derived and imported HMAC keys", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const env = {
      MAIN_SECRET: `api-key-cache-${crypto.randomUUID()}`,
    } as Env;

    await hashApiKeySecret(env, "ifk_live_prefix.secret");
    await hashApiKeySecret(env, "ifk_live_prefix.secret");

    expect(importKey).toHaveBeenCalledTimes(2);
    importKey.mockRestore();
  });

  it("throws when hashing API keys without a root secret", async () => {
    await expect(
      hashApiKeySecret({} as Env, "ifk_live_prefix.secret"),
    ).rejects.toThrow(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for API keys",
    );
  });

  it("timingSafeEqualString returns false for different lengths", () => {
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
  });

  it("normalizes scopes, site ids, and lifecycle status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));

    expect(
      normalizeApiKeyScopes([
        "analytics:read",
        "analysis:read",
        "analysis:write",
        "unknown",
        null,
        "site:read",
        "analytics:read",
      ]),
    ).toEqual([
      "analytics:read",
      "analysis:read",
      "analysis:write",
      "site:read",
    ]);
    expect(normalizeApiKeyScopes(null as unknown as unknown[])).toEqual([]);
    expect(
      normalizeApiKeySiteIds([" site-1 ", "", "site-1", "site-2"]),
    ).toEqual(["site-1", "site-2"]);
    expect(normalizeApiKeySiteIds(null as unknown as unknown[])).toEqual([]);
    expect(apiKeyStatus({ expires_at: null, revoked_at: null })).toBe("active");
    expect(apiKeyStatus({ expires_at: 1, revoked_at: null })).toBe("expired");
    expect(apiKeyStatus({ expires_at: null, revoked_at: 2 })).toBe("revoked");
    expect(apiKeyStatus({ expires_at: null, revoked_at: null }, 1000)).toBe(
      "active",
    );
    expect(apiKeyStatus({ expires_at: 999, revoked_at: null }, 1000)).toBe(
      "expired",
    );

    vi.useRealTimers();
  });

  it("revoked takes precedence over expired", () => {
    expect(apiKeyStatus({ expires_at: 1, revoked_at: 2 })).toBe("revoked");
  });
});

describe("toPublicApiKey", () => {
  it("converts a row to public representation", () => {
    const row = makeRow();
    const pub = toPublicApiKey(row);
    expect(pub.id).toBe("key-1");
    expect(pub.teamId).toBe("team-1");
    expect(pub.name).toBe("CI");
    expect(pub.prefix).toBe("prefix123");
    expect(pub.scopes).toEqual(["site:read", "analytics:read"]);
    expect(pub.siteIds).toEqual([]);
    expect(pub.createdByUserId).toBe("user-1");
    expect(pub.status).toBe("active");
  });

  it("handles null fields gracefully", () => {
    const row = makeRow({
      created_by_user_id: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: null,
    });
    const pub = toPublicApiKey(row);
    expect(pub.createdByUserId).toBe("");
    expect(pub.revokedByUserId).toBe("");
    expect(pub.rotatedFromKeyId).toBe("");
    expect(pub.lastUsedAt).toBeNull();
  });

  it("treats malformed and non-array JSON fields as empty", () => {
    expect(
      toPublicApiKey(
        makeRow({ scopes_json: "not-json", site_ids_json: '"site-1"' }),
      ),
    ).toMatchObject({ scopes: [], siteIds: [] });
  });

  it("reflects revoked status", () => {
    const row = makeRow({ revoked_at: 100 });
    const pub = toPublicApiKey(row);
    expect(pub.status).toBe("revoked");
  });

  it("reflects expired status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));
    const row = makeRow({ expires_at: 1 });
    const pub = toPublicApiKey(row);
    expect(pub.status).toBe("expired");
    vi.useRealTimers();
  });
});

describe("serializeScopes / serializeSiteIds", () => {
  it("serializes scopes to JSON", () => {
    const result = serializeScopes(["site:read", "analytics:read"]);
    expect(JSON.parse(result)).toEqual(["site:read", "analytics:read"]);
  });

  it("deduplicates and filters invalid scopes", () => {
    const result = serializeScopes([
      "site:read",
      "site:read",
      "unknown" as never,
    ]);
    expect(JSON.parse(result)).toEqual(["site:read"]);
  });

  it("serializes site ids to JSON", () => {
    const result = serializeSiteIds(["site-1", "site-2"]);
    expect(JSON.parse(result)).toEqual(["site-1", "site-2"]);
  });

  it("deduplicates and filters empty site ids", () => {
    const result = serializeSiteIds(["site-1", "", "site-1"]);
    expect(JSON.parse(result)).toEqual(["site-1"]);
  });
});

describe("expiresAtFromDays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for null or 'never'", () => {
    expect(expiresAtFromDays(null)).toBeNull();
    expect(expiresAtFromDays("never")).toBeNull();
  });

  it("computes expiry for valid day values", () => {
    const result = expiresAtFromDays(30);
    expect(result).toBe(Math.floor(Date.now() / 1000) + 30 * 86400);
  });

  it("falls back to default for invalid day values", () => {
    const result = expiresAtFromDays(999);
    expect(result).toBe(Math.floor(Date.now() / 1000) + 180 * 86400);
  });

  it("uses default when input is undefined", () => {
    const result = expiresAtFromDays(undefined);
    expect(result).toBe(Math.floor(Date.now() / 1000) + 180 * 86400);
  });
});

describe("DB operations", () => {
  it("listApiKeys returns mapped public keys", async () => {
    const env = createMockEnv(null, [makeRow()]);
    const result = await listApiKeys(env, "team-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("key-1");
  });

  it("getApiKeyById returns a row or null", async () => {
    const envWithRow = createMockEnv(makeRow());
    const row = await getApiKeyById(envWithRow, "key-1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("key-1");

    const envNull = createMockEnv(null);
    const missing = await getApiKeyById(envNull, "missing");
    expect(missing).toBeNull();
  });

  it("getApiKeyByPrefix returns a row or null", async () => {
    const envWithRow = createMockEnv(makeRow());
    const row = await getApiKeyByPrefix(envWithRow, "prefix123");
    expect(row).not.toBeNull();

    const envNull = createMockEnv(null);
    const missing = await getApiKeyByPrefix(envNull, "nope");
    expect(missing).toBeNull();
  });

  it("createApiKeyRecord inserts and returns created key", async () => {
    const row = makeRow();
    const env = createMockEnv(row);
    const result = await createApiKeyRecord(env, {
      teamId: "team-1",
      name: "CI",
      scopes: ["site:read"],
      siteIds: [],
    });

    expect(result.key.id).toBe("key-1");
    expect(result.secret).toMatch(/^ifk_live_/);
  });

  it("createApiKeyRecord throws if row not found after insert", async () => {
    const env = createMockEnv(null);
    await expect(
      createApiKeyRecord(env, {
        teamId: "team-1",
        name: "CI",
        scopes: ["site:read"],
        siteIds: [],
      }),
    ).rejects.toThrow("api_key_create_failed");
  });

  it("revokeApiKeyRecord returns null if key not found", async () => {
    const env = createMockEnv(null);
    const result = await revokeApiKeyRecord(env, {
      keyId: "missing",
      teamId: "team-1",
    });
    expect(result).toBeNull();
  });

  it("revokeApiKeyRecord returns revoked key", async () => {
    const row = makeRow({ revoked_at: 100 });
    const env = createMockEnv(row);
    const result = await revokeApiKeyRecord(env, {
      keyId: "key-1",
      teamId: "team-1",
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("revoked");
  });

  it("markApiKeyUsed executes update", async () => {
    const env = createMockEnv();
    await markApiKeyUsed(env, "key-1");
    expect(env.DB.prepare).toHaveBeenCalled();
  });
});
