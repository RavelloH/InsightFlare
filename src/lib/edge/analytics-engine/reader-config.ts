import {
  type AnalyticsEngineConfig,
  defaultAnalyticsEngineConfig,
  makeSecretHint,
  normalizeAnalyticsEngineConfig,
  SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
} from "@/lib/analytics-engine-config";
import { decryptAnalyticsEngineSecret } from "@/lib/edge/auth/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";

/**
 * Reader credentials provided by the deployment (INSIGHTFLARE_AE_ACCOUNT_ID
 * plus the INSIGHTFLARE_AE_API_TOKEN Worker secret). Presence of the token
 * decides: once a deployment manages the reader, the admin setting is ignored
 * and becomes read-only.
 */
export function environmentAnalyticsEngineConfig(
  env: Env,
): AnalyticsEngineConfig | null {
  const token = env.INSIGHTFLARE_AE_API_TOKEN?.trim();
  if (!token) return null;
  return {
    ...defaultAnalyticsEngineConfig(),
    accountId: env.INSIGHTFLARE_AE_ACCOUNT_ID?.trim() ?? "",
    apiTokenHint: makeSecretHint(token),
    configured: true,
    source: "environment",
  };
}

export function analyticsEngineReaderManagedByEnvironment(env: Env): boolean {
  return Boolean(env.INSIGHTFLARE_AE_API_TOKEN?.trim());
}

/** Effective reader configuration: deployment environment first, then the admin setting. */
export async function readAnalyticsEngineReaderConfig(
  env: Env,
): Promise<AnalyticsEngineConfig> {
  const fromEnvironment = environmentAnalyticsEngineConfig(env);
  if (fromEnvironment) return fromEnvironment;
  const raw = await readConfig(env, SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY);
  return raw
    ? normalizeAnalyticsEngineConfig(raw)
    : defaultAnalyticsEngineConfig();
}

/** Plain API token for the SQL API; throws when a stored token cannot be decrypted. */
export async function analyticsEngineReaderToken(
  env: Env,
  config: AnalyticsEngineConfig,
): Promise<string> {
  if (config.source === "environment")
    return env.INSIGHTFLARE_AE_API_TOKEN?.trim() ?? "";
  return decryptAnalyticsEngineSecret(env, config.apiTokenEncrypted);
}
