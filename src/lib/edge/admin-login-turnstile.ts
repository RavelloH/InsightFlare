import {
  defaultLoginTurnstileConfig,
  type LoginTurnstileConfig,
  type LoginTurnstileUpdateInput,
  makeSecretHint,
  normalizeLoginTurnstileConfig,
  redactLoginTurnstileConfig,
  SYSTEM_LOGIN_TURNSTILE_CONFIG_KEY,
  toLoginTurnstileRuntimeConfig,
  validateLoginTurnstileConfig,
  validateLoginTurnstileUpdateInput,
} from "@/lib/auth/login-turnstile-config";

import { requireActor } from "./admin-auth";
import { bad, forb, jsonResponseFor, na, parseJson } from "./admin-response";
import {
  deleteLoginTurnstileRuntimeConfig,
  writeLoginTurnstileRuntimeConfig,
} from "./login-turnstile-runtime";
import { encryptLoginTurnstileSecret } from "./secret-encryption";
import { deleteConfig, readConfig, upsertConfig } from "./system-config";
import { verifyTurnstileToken } from "./turnstile-siteverify";
import type { Env } from "./types";

function responseData(config: LoginTurnstileConfig) {
  return { ok: true, data: redactLoginTurnstileConfig(config) };
}

async function readLoginTurnstileConfig(
  env: Env,
): Promise<LoginTurnstileConfig> {
  const raw = await readConfig(env, SYSTEM_LOGIN_TURNSTILE_CONFIG_KEY);
  return raw
    ? normalizeLoginTurnstileConfig(raw)
    : defaultLoginTurnstileConfig();
}

function applyUpdateInput(
  current: LoginTurnstileConfig,
  input: LoginTurnstileUpdateInput,
): LoginTurnstileConfig {
  const next = normalizeLoginTurnstileConfig(current);
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.siteKey !== undefined) next.siteKey = input.siteKey;
  next.mode = "invisible";
  return next;
}

export async function handleLoginTurnstileConfigAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can manage login Turnstile settings",
      undefined,
      req,
    );
  }

  if (req.method === "GET") {
    const config = await readLoginTurnstileConfig(env);
    return jsonResponseFor(req, responseData(config));
  }

  if (req.method === "DELETE") {
    await deleteConfig(env, SYSTEM_LOGIN_TURNSTILE_CONFIG_KEY);
    try {
      await deleteLoginTurnstileRuntimeConfig(env);
    } catch (error) {
      return bad(
        error instanceof Error ? error.message : "login_turnstile_kv_missing",
        "login_turnstile_runtime_sync_failed",
        req,
      );
    }
    return jsonResponseFor(req, responseData(defaultLoginTurnstileConfig()));
  }

  if (req.method !== "POST" && req.method !== "PATCH") return na(req);

  const validation = validateLoginTurnstileUpdateInput(await parseJson(req));
  if (!validation.ok) return bad(validation.message, undefined, req);

  const current = await readLoginTurnstileConfig(env);
  const next = applyUpdateInput(current, validation.input);
  const nextSecretKey = validation.input.secretKey?.trim() || "";

  if (nextSecretKey) {
    try {
      next.secretKeyEncrypted = await encryptLoginTurnstileSecret(
        env,
        nextSecretKey,
      );
      next.secretKeyHint = makeSecretHint(nextSecretKey);
    } catch (error) {
      return bad(
        error instanceof Error
          ? error.message
          : "Unable to encrypt login Turnstile secret",
        "login_turnstile_secret_encryption_failed",
        req,
      );
    }
  }

  next.updatedAt = Date.now();
  next.updatedByUserId = actor.user.id;

  const configError = validateLoginTurnstileConfig(next);
  if (configError) return bad(configError, undefined, req);

  await upsertConfig(
    env,
    SYSTEM_LOGIN_TURNSTILE_CONFIG_KEY,
    next as unknown as Record<string, unknown>,
  );

  try {
    await writeLoginTurnstileRuntimeConfig(
      env,
      toLoginTurnstileRuntimeConfig(next),
    );
  } catch (error) {
    return bad(
      error instanceof Error
        ? error.message
        : "Configuration save failed or runtime sync failed. Please retry.",
      "login_turnstile_runtime_sync_failed",
      req,
    );
  }

  return jsonResponseFor(req, responseData(next));
}

export async function handleLoginTurnstileTestAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can test login Turnstile settings",
      undefined,
      req,
    );
  }
  if (req.method !== "POST") return na(req);

  const body = await parseJson(req);
  const siteKey = typeof body.siteKey === "string" ? body.siteKey.trim() : "";
  const secretKey =
    typeof body.secretKey === "string" ? body.secretKey.trim() : "";
  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";

  if (!siteKey) return bad("Site Key is required", "site_key_required", req);
  if (!secretKey)
    return bad("Secret Key is required", "secret_key_required", req);
  if (!turnstileToken)
    return bad("Turnstile token is required", "turnstile_required", req);

  const result = await verifyTurnstileToken({
    requireSiteverifyUrl: env.INSIGHTFLARE_E2E === "1",
    secret: secretKey,
    token: turnstileToken,
    siteverifyUrl:
      env.INSIGHTFLARE_E2E === "1"
        ? env.INSIGHTFLARE_E2E_TURNSTILE_SITEVERIFY_URL
        : undefined,
  });

  if (!result.ok) {
    return bad(
      "Turnstile verification failed",
      "turnstile_verification_failed",
      req,
    );
  }

  return jsonResponseFor(req, {
    ok: true,
    data: {
      verified: true,
      siteKey,
      hostname: result.hostname,
    },
  });
}
