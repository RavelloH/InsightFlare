import { jsonError } from "@/lib/api-v1/wire-helpers";

import {
  type ApiKeyScope,
  apiKeyStatus,
  getApiKeyByPrefix,
  hashApiKeySecret,
  markApiKeyUsed,
  normalizeApiKeyScopes,
  normalizeApiKeySiteIds,
  parseApiKey,
  timingSafeEqualString,
} from "./api-key-store";
import type { Env } from "./types";
import { nowEpochSeconds } from "./utils";

export const API_KEY_USAGE_WRITE_INTERVAL_SECONDS = 5 * 60;

export interface ApiKeyPrincipal {
  keyId: string;
  teamId: string;
  name?: string;
  prefix: string;
  scopes: ApiKeyScope[];
  siteIds: string[];
  createdAt?: number;
  expiresAt?: number | null;
  lastUsedAt?: number | null;
  status?: "active" | "expired" | "revoked";
}

export function extractApiKeyToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function safeJsonArray(input: string): unknown[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function authenticateApiKey(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<ApiKeyPrincipal | Response> {
  const token = extractApiKeyToken(request);
  const parsed = parseApiKey(token);
  if (!parsed) {
    return jsonError(
      "invalid_api_key",
      "Invalid or missing API key",
      401,
      undefined,
      request,
    );
  }

  const row = await getApiKeyByPrefix(env, parsed.prefix);
  if (!row) {
    return jsonError(
      "invalid_api_key",
      "Invalid or missing API key",
      401,
      undefined,
      request,
    );
  }

  const actualHash = await hashApiKeySecret(env, token);
  if (!timingSafeEqualString(actualHash, row.key_hash)) {
    return jsonError(
      "invalid_api_key",
      "Invalid or missing API key",
      401,
      undefined,
      request,
    );
  }

  const status = apiKeyStatus(row);
  if (status === "revoked") {
    return jsonError(
      "api_key_revoked",
      "API key has been revoked",
      401,
      undefined,
      request,
    );
  }
  if (status === "expired") {
    return jsonError(
      "api_key_expired",
      "API key has expired",
      401,
      undefined,
      request,
    );
  }

  const now = nowEpochSeconds();
  if (
    row.last_used_at === null ||
    row.last_used_at < now - API_KEY_USAGE_WRITE_INTERVAL_SECONDS
  ) {
    const update = markApiKeyUsed(env, row.id);
    if (ctx) {
      ctx.waitUntil(update);
    } else {
      await update;
    }
  }

  return {
    keyId: row.id,
    teamId: row.team_id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: normalizeApiKeyScopes(safeJsonArray(row.scopes_json)),
    siteIds: normalizeApiKeySiteIds(safeJsonArray(row.site_ids_json)),
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    status,
  };
}

export function hasApiScope(
  principal: ApiKeyPrincipal,
  scope: ApiKeyScope,
): boolean {
  return principal.scopes.includes(scope);
}

export function hasFullSiteAccess(principal: ApiKeyPrincipal): boolean {
  return principal.siteIds.length === 0;
}

export function canAccessSiteId(
  principal: ApiKeyPrincipal,
  siteId: string,
): boolean {
  return hasFullSiteAccess(principal) || principal.siteIds.includes(siteId);
}

export function requireApiScope(
  principal: ApiKeyPrincipal,
  scope: ApiKeyScope,
): Response | null {
  if (hasApiScope(principal, scope)) return null;
  return jsonError(
    "insufficient_scope",
    "Insufficient scope for this action",
    403,
  );
}
