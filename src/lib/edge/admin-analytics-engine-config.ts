import {
  type AnalyticsEngineConfig,
  defaultAnalyticsEngineConfig,
  makeSecretHint,
  normalizeAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
  SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
  validateAnalyticsEngineConfig,
  validateAnalyticsEngineUpdateInput,
} from "@/lib/analytics-engine-config";
import { SECRET_PURPOSES } from "@/lib/secrets";

import { requireActor } from "./admin-auth";
import { bad, forb, jsonResponseFor, na, parseJson } from "./admin-response";
import { analyticsEngineAvailability } from "./analytics-engine";
import { encryptSecret } from "./secret-encryption";
import { deleteConfig, readConfig, upsertConfig } from "./system-config";
import type { Env } from "./types";

type AdminActor = Awaited<ReturnType<typeof requireActor>>;

function requireAdmin(actor: AdminActor, request: Request): Response | null {
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can manage Analytics Engine settings",
      undefined,
      request,
    );
  }
  return null;
}

function responseData(env: Env, config: AnalyticsEngineConfig) {
  return {
    ok: true,
    data: redactAnalyticsEngineConfig(config, analyticsEngineAvailability(env)),
  };
}

function nextConfig(
  current: AnalyticsEngineConfig,
  input: {
    accountId?: string;
    clearApiToken?: boolean;
  },
): AnalyticsEngineConfig {
  const next = normalizeAnalyticsEngineConfig(
    current as unknown as Record<string, unknown>,
  );
  if (input.accountId !== undefined) next.accountId = input.accountId;
  if (input.clearApiToken) {
    next.apiTokenEncrypted = "";
    next.apiTokenHint = "";
    next.configured = false;
  }
  return next;
}

export async function handleAnalyticsEngineConfigAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  const authError = requireAdmin(actor, req);
  if (authError) return authError;

  const rawConfig = await readConfig(env, SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY);
  const current = rawConfig
    ? normalizeAnalyticsEngineConfig(rawConfig)
    : defaultAnalyticsEngineConfig();

  if (req.method === "GET") {
    return jsonResponseFor(req, responseData(env, current));
  }

  if (analyticsEngineAvailability(env).analyticsEngineDisabled) {
    return bad(
      "Analytics Engine is disabled for this deployment. Enable Analytics Engine in Cloudflare and redeploy before editing Analytics Engine settings.",
      "analytics_engine_disabled",
      req,
    );
  }

  if (req.method === "DELETE") {
    await deleteConfig(env, SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY);
    return jsonResponseFor(
      req,
      responseData(env, defaultAnalyticsEngineConfig()),
    );
  }

  if (req.method !== "POST" && req.method !== "PATCH") return na(req);

  const validation = validateAnalyticsEngineUpdateInput(await parseJson(req));
  if (!validation.ok) return bad(validation.message, undefined, req);

  const next = nextConfig(current, validation.input);
  const nextToken = validation.input.apiToken?.trim() || "";
  if (nextToken) {
    try {
      next.apiTokenEncrypted = await encryptSecret(
        env,
        nextToken,
        SECRET_PURPOSES.analyticsEngineSecretEncryption,
      );
      next.apiTokenHint = makeSecretHint(nextToken);
      next.configured = true;
    } catch (error) {
      return bad(
        error instanceof Error
          ? error.message
          : "Unable to encrypt Cloudflare API token",
        "analytics_engine_secret_encryption_failed",
        req,
      );
    }
  }

  next.updatedAt = Date.now();
  next.updatedByUserId = actor instanceof Response ? undefined : actor.user.id;

  const configError = validateAnalyticsEngineConfig(next);
  if (configError) return bad(configError, undefined, req);

  await upsertConfig(
    env,
    SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
    next as unknown as Record<string, unknown>,
  );
  return jsonResponseFor(req, responseData(env, next));
}
