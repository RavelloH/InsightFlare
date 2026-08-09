import {
  defaultNotificationEmailConfig,
  isValidEmail,
  makeSecretHint,
  normalizeNotificationEmailConfig,
  type NotificationEmailConfig,
  type NotificationEmailConfigUpdateInput,
  redactNotificationEmailConfig,
  SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY,
  validateNotificationEmailConfig,
  validateNotificationEmailUpdateInput,
} from "@/lib/notifications/email-config";
import {
  buildResendFromAddress,
  sanitizeProviderError,
  sendResendEmailWithRetry,
} from "@/lib/notifications/resend-client";

import { requireActor } from "./admin-auth";
import { bad, forb, jsonResponseFor, na, parseJson } from "./admin-response";
import {
  decryptNotificationSecret,
  encryptNotificationSecret,
} from "./secret-encryption";
import { deleteConfig, readConfig, upsertConfig } from "./system-config";
import type { Env } from "./types";

const TEST_EMAIL_SUBJECT = "InsightFlare email test";
const TEST_EMAIL_TEXT =
  "This is a test email from InsightFlare. Your Resend email configuration is working.";
const TEST_EMAIL_HTML =
  "<p>This is a test email from InsightFlare.</p><p>Your Resend email configuration is working.</p>";

type NotificationEmailTestOptions = {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  maxAttempts?: number;
};

function applyUpdateInput(
  current: NotificationEmailConfig,
  input: NotificationEmailConfigUpdateInput,
): NotificationEmailConfig {
  const next = normalizeNotificationEmailConfig(current);
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.provider !== undefined) next.provider = input.provider;
  if (input.fromName !== undefined) next.fromName = input.fromName;
  if (input.fromEmail !== undefined) next.fromEmail = input.fromEmail;
  if (input.replyTo !== undefined) next.replyTo = input.replyTo;
  if (input.clearResendApiKey) {
    next.resend = {
      apiKeyEncrypted: "",
      apiKeyHint: "",
      configured: false,
    };
  }
  return next;
}

function responseData(config: NotificationEmailConfig) {
  return { ok: true, data: redactNotificationEmailConfig(config) };
}

async function readNotificationEmailConfig(
  env: Env,
): Promise<NotificationEmailConfig> {
  const raw = await readConfig(env, SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY);
  return raw
    ? normalizeNotificationEmailConfig(raw)
    : defaultNotificationEmailConfig();
}

function currentActorEmail(actor: Awaited<ReturnType<typeof requireActor>>) {
  if (actor instanceof Response) return "";
  return actor.user.email || "";
}

export async function handleNotificationEmailConfigAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can manage notification email settings",
      undefined,
      req,
    );
  }

  if (req.method === "GET") {
    const config = await readNotificationEmailConfig(env);
    return jsonResponseFor(req, responseData(config));
  }

  if (req.method === "DELETE") {
    await deleteConfig(env, SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY);
    return jsonResponseFor(req, responseData(defaultNotificationEmailConfig()));
  }

  if (req.method !== "POST" && req.method !== "PATCH") return na(req);

  const validation = validateNotificationEmailUpdateInput(await parseJson(req));
  if (!validation.ok) return bad(validation.message, undefined, req);

  const current = await readNotificationEmailConfig(env);
  const next = applyUpdateInput(current, validation.input);
  const nextApiKey = validation.input.resendApiKey?.trim() || "";
  if (nextApiKey) {
    try {
      next.resend = {
        apiKeyEncrypted: await encryptNotificationSecret(env, nextApiKey),
        apiKeyHint: makeSecretHint(nextApiKey),
        configured: true,
      };
    } catch (error) {
      return bad(
        error instanceof Error
          ? error.message
          : "Unable to encrypt notification secret",
        "notification_secret_encryption_failed",
        req,
      );
    }
  }
  next.updatedAt = Date.now();
  next.updatedByUserId = actor.user.id;

  const configError = validateNotificationEmailConfig(next);
  if (configError) return bad(configError, undefined, req);

  await upsertConfig(
    env,
    SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY,
    next as unknown as Record<string, unknown>,
  );
  return jsonResponseFor(req, responseData(next));
}

export async function handleNotificationEmailTestAdmin(
  req: Request,
  env: Env,
  options: NotificationEmailTestOptions = {},
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can test notification email settings",
      undefined,
      req,
    );
  }
  if (req.method !== "POST") return na(req);

  const body = await parseJson(req);
  const explicitTo = typeof body.to === "string" ? body.to.trim() : "";
  const to = explicitTo || currentActorEmail(actor);
  if (!isValidEmail(to))
    return bad("Invalid test recipient email", undefined, req);

  const config = await readNotificationEmailConfig(env);
  if (config.provider !== "resend") {
    return bad("Resend provider is required for test email", undefined, req);
  }
  if (!config.fromEmail || !isValidEmail(config.fromEmail)) {
    return bad("A valid fromEmail is required for test email", undefined, req);
  }
  if (!config.resend.configured || !config.resend.apiKeyEncrypted) {
    return bad("Resend API Key is required for test email", undefined, req);
  }

  let apiKey: string;
  try {
    apiKey = await decryptNotificationSecret(
      env,
      config.resend.apiKeyEncrypted,
    );
  } catch {
    return bad(
      "Unable to decrypt saved Resend API Key",
      "notification_secret_decryption_failed",
      req,
    );
  }

  const resendBody = {
    from: buildResendFromAddress(config),
    to: [to],
    subject: TEST_EMAIL_SUBJECT,
    text: TEST_EMAIL_TEXT,
    html: TEST_EMAIL_HTML,
  };
  const emailBody = config.replyTo
    ? { ...resendBody, reply_to: config.replyTo }
    : resendBody;

  const result = await sendResendEmailWithRetry({
    apiKey,
    apiUrl:
      env.INSIGHTFLARE_E2E === "1"
        ? env.INSIGHTFLARE_E2E_RESEND_API_URL
        : undefined,
    body: emailBody,
    ...options,
  });

  if (!result.ok && result.reason === "network_failed") {
    return bad(result.errorMessage, "resend_request_failed", req);
  }

  if (!result.ok) {
    return bad(
      `Resend request failed: ${sanitizeProviderError(result.payload)}`,
      "resend_request_failed",
      req,
    );
  }

  return jsonResponseFor(req, {
    ok: true,
    data: {
      provider: "resend",
      messageId: result.providerMessageId,
      durationMs: result.durationMs,
      attempts: result.attempts,
      retryCount: result.retryCount,
    },
  });
}
