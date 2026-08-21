import { apiKeyHashSecret as resolveApiKeyHashSecret } from "@/lib/secrets";

import type { Env } from "./types";
import { clampString, nowEpochSeconds } from "./utils";

export const API_KEY_PREFIX = "ifk_live_";
export const DEFAULT_API_KEY_EXPIRES_IN_DAYS = 180;
export const API_KEY_EXPIRATION_DAYS = [30, 90, 180, 365] as const;

export const API_KEY_SCOPES = [
  "analytics:read",
  "analysis:read",
  "analysis:write",
  "site:read",
  "site:write",
  "site_config:read",
  "site_config:write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  team_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: string;
  site_ids_json: string;
  created_by_user_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by_user_id: string | null;
  rotated_from_key_id: string | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicApiKey {
  id: string;
  teamId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  siteIds: string[];
  createdByUserId: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedByUserId: string;
  rotatedFromKeyId: string;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  status: "active" | "expired" | "revoked";
}

export interface CreatedApiKey {
  key: PublicApiKey;
  secret: string;
}

const API_KEY_SECRET_BYTES = 32;
const API_KEY_PREFIX_BYTES = 9;
const DEFAULT_SCOPE_SET = new Set<ApiKeyScope>(API_KEY_SCOPES);
// The derived secret is deployment configuration, so this cache cannot grow
// from request input. CryptoKey is immutable and safe to reuse across requests.
const apiKeyHmacKeyCache = new Map<string, CryptoKey>();

async function apiKeyHashSecret(env: Env): Promise<string> {
  const secret = await resolveApiKeyHashSecret(env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for API keys",
    );
  }
  return secret;
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function bytes(input: string): Uint8Array {
  const encoded = new TextEncoder().encode(input);
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < input.length; i += 1) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hex(input: Uint8Array): string {
  return Array.from(input)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomTokenPart(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  let key = apiKeyHmacKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(bytes(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    apiKeyHmacKeyCache.set(secret, key);
  }
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(bytes(message)),
  );
  return hex(new Uint8Array(signature));
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = bytes(left);
  const rightBytes = bytes(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }
  return diff === 0;
}

export async function hashApiKeySecret(
  env: Env,
  apiKey: string,
): Promise<string> {
  return hmacSha256Hex(apiKey, await apiKeyHashSecret(env));
}

export function generateApiKeySecret(): {
  apiKey: string;
  prefix: string;
} {
  const prefix = randomTokenPart(API_KEY_PREFIX_BYTES);
  const secret = randomTokenPart(API_KEY_SECRET_BYTES);
  return {
    prefix,
    apiKey: `${API_KEY_PREFIX}${prefix}.${secret}`,
  };
}

export function parseApiKey(value: string): { prefix: string } | null {
  const token = value.trim();
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const withoutScheme = token.slice(API_KEY_PREFIX.length);
  const dotIndex = withoutScheme.indexOf(".");
  if (dotIndex <= 0 || dotIndex === withoutScheme.length - 1) return null;
  const prefix = withoutScheme.slice(0, dotIndex);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(prefix)) return null;
  return { prefix };
}

function safeJsonArray(input: string): unknown[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeApiKeyScopes(input: unknown): ApiKeyScope[] {
  const raw = Array.isArray(input) ? input : [];
  const out: ApiKeyScope[] = [];
  for (const value of raw) {
    const scope = String(value || "").trim() as ApiKeyScope;
    if (!DEFAULT_SCOPE_SET.has(scope)) continue;
    if (out.includes(scope)) continue;
    out.push(scope);
  }
  return out;
}

export function normalizeApiKeySiteIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const value of raw) {
    const siteId = clampString(String(value || "").trim(), 120);
    if (!siteId || out.includes(siteId)) continue;
    out.push(siteId);
  }
  return out;
}

export function apiKeyStatus(
  row: Pick<ApiKeyRow, "expires_at" | "revoked_at">,
  now = nowEpochSeconds(),
): PublicApiKey["status"] {
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return "revoked";
  }
  if (
    row.expires_at !== null &&
    row.expires_at !== undefined &&
    row.expires_at <= now
  ) {
    return "expired";
  }
  return "active";
}

export function toPublicApiKey(row: ApiKeyRow): PublicApiKey {
  const scopes = normalizeApiKeyScopes(safeJsonArray(row.scopes_json));
  const siteIds = normalizeApiKeySiteIds(safeJsonArray(row.site_ids_json));
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    prefix: row.key_prefix,
    scopes,
    siteIds,
    createdByUserId: row.created_by_user_id || "",
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    revokedByUserId: row.revoked_by_user_id || "",
    rotatedFromKeyId: row.rotated_from_key_id || "",
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: apiKeyStatus(row),
  };
}

export function serializeScopes(scopes: ApiKeyScope[]): string {
  return JSON.stringify(normalizeApiKeyScopes(scopes));
}

export function serializeSiteIds(siteIds: string[]): string {
  return JSON.stringify(normalizeApiKeySiteIds(siteIds));
}

export function expiresAtFromDays(input: unknown): number | null {
  if (input === null || input === "never") return null;
  const days = Number(input ?? DEFAULT_API_KEY_EXPIRES_IN_DAYS);
  if (!API_KEY_EXPIRATION_DAYS.includes(days as never)) {
    return nowEpochSeconds() + DEFAULT_API_KEY_EXPIRES_IN_DAYS * 24 * 60 * 60;
  }
  return nowEpochSeconds() + days * 24 * 60 * 60;
}

export async function listApiKeys(
  env: Env,
  teamId: string,
): Promise<PublicApiKey[]> {
  const rows = await env.DB.prepare(
    `
      SELECT
        id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
        created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
        rotated_from_key_id, last_used_at, created_at, updated_at
      FROM api_keys
      WHERE team_id = ?
      ORDER BY created_at DESC
    `,
  )
    .bind(teamId)
    .all<ApiKeyRow>();
  return rows.results.map(toPublicApiKey);
}

export async function getApiKeyById(
  env: Env,
  keyId: string,
): Promise<ApiKeyRow | null> {
  return (
    (await env.DB.prepare(
      `
        SELECT
          id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
          created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
          rotated_from_key_id, last_used_at, created_at, updated_at
        FROM api_keys
        WHERE id = ?
        LIMIT 1
      `,
    )
      .bind(keyId)
      .first<ApiKeyRow>()) ?? null
  );
}

export async function getApiKeyByPrefix(
  env: Env,
  prefix: string,
): Promise<ApiKeyRow | null> {
  return (
    (await env.DB.prepare(
      `
        SELECT
          id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
          created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
          rotated_from_key_id, last_used_at, created_at, updated_at
        FROM api_keys
        WHERE key_prefix = ?
        LIMIT 1
      `,
    )
      .bind(prefix)
      .first<ApiKeyRow>()) ?? null
  );
}

export async function createApiKeyRecord(
  env: Env,
  input: {
    teamId: string;
    name: string;
    scopes: ApiKeyScope[];
    siteIds: string[];
    createdByUserId?: string | null;
    expiresAt?: number | null;
    rotatedFromKeyId?: string | null;
  },
): Promise<CreatedApiKey> {
  const generated = generateApiKeySecret();
  const hash = await hashApiKeySecret(env, generated.apiKey);
  const keyId = crypto.randomUUID();
  await env.DB.prepare(
    `
      INSERT INTO api_keys (
        id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
        created_by_user_id, expires_at, rotated_from_key_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `,
  )
    .bind(
      keyId,
      input.teamId,
      clampString(input.name.trim(), 120),
      generated.prefix,
      hash,
      serializeScopes(input.scopes),
      serializeSiteIds(input.siteIds),
      input.createdByUserId || null,
      input.expiresAt ?? null,
      input.rotatedFromKeyId || null,
    )
    .run();
  const row = await getApiKeyById(env, keyId);
  if (!row) throw new Error("api_key_create_failed");
  return {
    key: toPublicApiKey(row),
    secret: generated.apiKey,
  };
}

export async function revokeApiKeyRecord(
  env: Env,
  input: {
    keyId: string;
    teamId: string;
    revokedByUserId?: string | null;
  },
): Promise<PublicApiKey | null> {
  await env.DB.prepare(
    `
      UPDATE api_keys
      SET revoked_at = COALESCE(revoked_at, unixepoch()),
          revoked_by_user_id = COALESCE(revoked_by_user_id, ?),
          updated_at = unixepoch()
      WHERE id = ? AND team_id = ?
    `,
  )
    .bind(input.revokedByUserId || null, input.keyId, input.teamId)
    .run();
  const row = await getApiKeyById(env, input.keyId);
  return row ? toPublicApiKey(row) : null;
}

export async function markApiKeyUsed(env: Env, keyId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE api_keys SET last_used_at=unixepoch() WHERE id=?",
  )
    .bind(keyId)
    .run();
}
