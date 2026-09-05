import { accountActionTokenHashSecret as resolveTokenHashSecret } from "@/lib/secrets";

import type { Env } from "./types";
import { clampString, nowEpochSeconds } from "./utils";

export const ACCOUNT_ACTION_TOKEN_TYPES = [
  "team_invite",
  "password_reset",
] as const;

export type AccountActionTokenType =
  (typeof ACCOUNT_ACTION_TOKEN_TYPES)[number];

export type AccountActionTokenStatus =
  "active" | "used" | "revoked" | "expired";

export interface AccountActionTokenRow {
  id: string;
  type: string;
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

export interface PublicAccountActionToken {
  id: string;
  type: AccountActionTokenType;
  teamId: string;
  userId: string;
  email: string;
  payload: Record<string, unknown>;
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUserId: string;
  revokedAt: number | null;
  status: AccountActionTokenStatus;
}

export interface CreatedAccountActionToken {
  token: string;
  record: PublicAccountActionToken;
}

const TOKEN_BYTES = 32;
const TYPE_SET = new Set<string>(ACCOUNT_ACTION_TOKEN_TYPES);

async function accountActionTokenHashSecret(env: Env): Promise<string> {
  const secret = await resolveTokenHashSecret(env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for account action tokens",
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

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(bytes(message)),
  );
  return hex(new Uint8Array(signature));
}

function safePayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  try {
    const parsed = JSON.parse(JSON.stringify(input)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safePayloadJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeNullableString(input: string | null | undefined, max = 120) {
  const value = clampString(String(input || "").trim(), max);
  return value || null;
}

function normalizeEmail(input: string | null | undefined) {
  const value = clampString(
    String(input || "")
      .trim()
      .toLowerCase(),
    200,
  );
  return value || null;
}

export function isAccountActionTokenType(
  input: unknown,
): input is AccountActionTokenType {
  return TYPE_SET.has(String(input || ""));
}

export function accountActionTokenStatus(
  row: Pick<AccountActionTokenRow, "expires_at" | "revoked_at" | "used_at">,
  now = nowEpochSeconds(),
): AccountActionTokenStatus {
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return "revoked";
  }
  if (row.used_at !== null && row.used_at !== undefined) {
    return "used";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  return "active";
}

export function generateAccountActionToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export async function hashAccountActionToken(
  env: Env,
  token: string,
): Promise<string> {
  return hmacSha256Hex(token, await accountActionTokenHashSecret(env));
}

export function toPublicAccountActionToken(
  row: AccountActionTokenRow,
): PublicAccountActionToken {
  return {
    id: row.id,
    type: isAccountActionTokenType(row.type) ? row.type : "team_invite",
    teamId: row.team_id || "",
    userId: row.user_id || "",
    email: row.email || "",
    payload: safePayloadJson(row.payload_json),
    createdByUserId: row.created_by_user_id || "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? null,
    usedByUserId: row.used_by_user_id || "",
    revokedAt: row.revoked_at ?? null,
    status: accountActionTokenStatus(row),
  };
}

export async function createAccountActionToken(
  env: Env,
  input: {
    type: AccountActionTokenType;
    expiresAt: number;
    teamId?: string | null;
    userId?: string | null;
    email?: string | null;
    payload?: Record<string, unknown> | null;
    tokenPayload?: (
      token: string,
    ) => Promise<Record<string, unknown> | null | undefined>;
    createdByUserId?: string | null;
  },
): Promise<CreatedAccountActionToken> {
  const token = generateAccountActionToken();
  const tokenHash = await hashAccountActionToken(env, token);
  const id = crypto.randomUUID();
  const payload = input.tokenPayload
    ? await input.tokenPayload(token)
    : input.payload;
  await env.DB.prepare(
    `
      INSERT INTO account_action_tokens (
        id, type, token_hash, team_id, user_id, email, payload_json,
        created_by_user_id, created_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
    `,
  )
    .bind(
      id,
      input.type,
      tokenHash,
      normalizeNullableString(input.teamId),
      normalizeNullableString(input.userId),
      normalizeEmail(input.email),
      JSON.stringify(safePayload(payload)),
      normalizeNullableString(input.createdByUserId),
      Math.max(0, Math.floor(input.expiresAt)),
    )
    .run();

  const row = await getAccountActionTokenById(env, id);
  if (!row) throw new Error("account_action_token_create_failed");
  return {
    token,
    record: toPublicAccountActionToken(row),
  };
}

export async function getAccountActionTokenById(
  env: Env,
  tokenId: string,
): Promise<AccountActionTokenRow | null> {
  return (
    (await env.DB.prepare(
      `
        SELECT
          id, type, token_hash, team_id, user_id, email, payload_json,
          created_by_user_id, created_at, expires_at, used_at,
          used_by_user_id, revoked_at
        FROM account_action_tokens
        WHERE id = ?
        LIMIT 1
      `,
    )
      .bind(tokenId)
      .first<AccountActionTokenRow>()) ?? null
  );
}

export async function getAccountActionTokenByToken(
  env: Env,
  token: string,
): Promise<AccountActionTokenRow | null> {
  const tokenHash = await hashAccountActionToken(env, token.trim());
  return (
    (await env.DB.prepare(
      `
        SELECT
          id, type, token_hash, team_id, user_id, email, payload_json,
          created_by_user_id, created_at, expires_at, used_at,
          used_by_user_id, revoked_at
        FROM account_action_tokens
        WHERE token_hash = ?
        LIMIT 1
      `,
    )
      .bind(tokenHash)
      .first<AccountActionTokenRow>()) ?? null
  );
}

export async function getValidAccountActionToken(
  env: Env,
  input: {
    token: string;
    type?: AccountActionTokenType;
  },
): Promise<AccountActionTokenRow | null> {
  const row = await getAccountActionTokenByToken(env, input.token);
  if (!row) return null;
  if (input.type && row.type !== input.type) return null;
  return accountActionTokenStatus(row) === "active" ? row : null;
}

export async function markAccountActionTokenUsed(
  env: Env,
  input: {
    tokenId: string;
    usedByUserId?: string | null;
  },
): Promise<AccountActionTokenRow | null> {
  await env.DB.prepare(
    `
      UPDATE account_action_tokens
      SET used_at = COALESCE(used_at, unixepoch()),
          used_by_user_id = COALESCE(used_by_user_id, ?)
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
    `,
  )
    .bind(normalizeNullableString(input.usedByUserId), input.tokenId)
    .run();
  return getAccountActionTokenById(env, input.tokenId);
}

export async function revokeAccountActionToken(
  env: Env,
  input: {
    tokenId: string;
  },
): Promise<AccountActionTokenRow | null> {
  await env.DB.prepare(
    `
      UPDATE account_action_tokens
      SET revoked_at = COALESCE(revoked_at, unixepoch())
      WHERE id = ? AND used_at IS NULL
    `,
  )
    .bind(input.tokenId)
    .run();
  return getAccountActionTokenById(env, input.tokenId);
}

export async function listTeamInviteTokens(
  env: Env,
  teamId: string,
): Promise<PublicAccountActionToken[]> {
  const rows = await env.DB.prepare(
    `
      SELECT
        id, type, token_hash, team_id, user_id, email, payload_json,
        created_by_user_id, created_at, expires_at, used_at,
        used_by_user_id, revoked_at
      FROM account_action_tokens
      WHERE team_id = ? AND type = 'team_invite'
      ORDER BY created_at DESC
    `,
  )
    .bind(teamId)
    .all<AccountActionTokenRow>();
  return rows.results.map(toPublicAccountActionToken);
}
