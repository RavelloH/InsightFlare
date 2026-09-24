import {
  LOGIN_TURNSTILE_RUNTIME_KV_KEY,
  type LoginTurnstileRuntimeConfig,
  type PublicLoginTurnstileConfig,
  toPublicLoginTurnstileConfig,
} from "@/lib/auth/login-turnstile-config";
import type { Env } from "@/lib/edge/types";
const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;
let runtimeCache: {
  expiresAt: number;
  config: LoginTurnstileRuntimeConfig | null;
} | null = null;
export function isLoginTurnstileEmergencyDisabled(env: Env): boolean {
  return (
    env.INSIGHTFLARE_LOGIN_TURNSTILE_DISABLED === "1" ||
    process.env.INSIGHTFLARE_LOGIN_TURNSTILE_DISABLED === "1"
  );
}
function normalizeRuntimeConfig(
  raw: unknown,
): LoginTurnstileRuntimeConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const enabled = input.enabled === true;
  const siteKey =
    typeof input.siteKey === "string" ? input.siteKey.trim().slice(0, 256) : "";
  const secretKeyEncrypted =
    typeof input.secretKeyEncrypted === "string"
      ? input.secretKeyEncrypted.trim().slice(0, 4096)
      : "";
  const mode = "invisible";
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : 0;
  if (!enabled || !siteKey || !secretKeyEncrypted) return null;
  return {
    enabled: true,
    siteKey,
    mode,
    secretKeyEncrypted,
    updatedAt,
  };
}
function loginTurnstileKv(env: Env): KVNamespace | null {
  return env.SITE_SETTINGS_KV ?? null;
}
export function clearLoginTurnstileRuntimeCache(): void {
  runtimeCache = null;
}
export async function readLoginTurnstileRuntimeConfig(
  env: Env,
): Promise<LoginTurnstileRuntimeConfig | null> {
  if (isLoginTurnstileEmergencyDisabled(env)) return null;

  const now = Date.now();
  if (runtimeCache && runtimeCache.expiresAt > now) {
    return runtimeCache.config;
  }

  const kv = loginTurnstileKv(env);
  if (!kv) {
    runtimeCache = {
      expiresAt: now + RUNTIME_CACHE_TTL_MS,
      config: null,
    };
    return null;
  }

  let config: LoginTurnstileRuntimeConfig | null = null;
  try {
    const raw = await kv.get(LOGIN_TURNSTILE_RUNTIME_KV_KEY, {
      cacheTtl: 300,
    });
    if (raw) {
      config = normalizeRuntimeConfig(JSON.parse(raw) as unknown);
    }
  } catch {
    config = null;
  }

  runtimeCache = {
    expiresAt: now + RUNTIME_CACHE_TTL_MS,
    config,
  };
  return config;
}
export async function readPublicLoginTurnstileRuntimeConfig(
  env: Env,
): Promise<PublicLoginTurnstileConfig> {
  return toPublicLoginTurnstileConfig(
    await readLoginTurnstileRuntimeConfig(env),
  );
}
export async function writeLoginTurnstileRuntimeConfig(
  env: Env,
  config: LoginTurnstileRuntimeConfig | null,
): Promise<void> {
  const kv = loginTurnstileKv(env);
  if (!kv) {
    throw new Error("login_turnstile_kv_missing");
  }
  if (!config) {
    await kv.delete(LOGIN_TURNSTILE_RUNTIME_KV_KEY);
  } else {
    await kv.put(LOGIN_TURNSTILE_RUNTIME_KV_KEY, JSON.stringify(config));
  }
  clearLoginTurnstileRuntimeCache();
}
export async function deleteLoginTurnstileRuntimeConfig(
  env: Env,
): Promise<void> {
  await writeLoginTurnstileRuntimeConfig(env, null);
}
