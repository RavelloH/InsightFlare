import type { ScheduledTaskLogger } from "@/lib/edge/scheduled-task-runner";
import { decryptNotificationSecret } from "@/lib/edge/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";
import {
  isValidEmail,
  normalizeNotificationEmailConfig,
  SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY,
} from "@/lib/notifications/email-config";
import { renderNotificationEmail } from "@/lib/notifications/email-renderer";
import { resolveNotificationMessageLocale } from "@/lib/notifications/locale";

import {
  type NotificationMessage,
  updateNotificationDeliveryResult,
} from "./message-store";
import { normalizeNotificationPreferences } from "./preferences";
import {
  buildResendFromAddress,
  sendResendEmailWithRetry,
} from "./resend-client";

type NotificationDeliveryLogger = Pick<
  ScheduledTaskLogger,
  "info" | "warn" | "error"
>;

export interface NotificationDeliveryUser {
  id: string;
  email: string;
  preferencesJson?: string | null;
  preferredLocale?: string | null;
  timeZone?: string | null;
}

function maskEmail(value: string): string {
  const [local = "", domain = ""] = value.split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 2)}***@${domain}`;
}

function fallbackRenderedEmail(message: NotificationMessage) {
  return {
    subject: message.title,
    text:
      message.bodyText ||
      message.summary ||
      "You have a new InsightFlare notification.",
    html: message.bodyHtml || undefined,
  };
}

export async function deliverNotificationMessage(
  env: Env,
  message: NotificationMessage,
  user: NotificationDeliveryUser,
  context: { logger?: NotificationDeliveryLogger; fetchImpl?: typeof fetch },
): Promise<NotificationMessage | null> {
  const preferences = normalizeNotificationPreferences(user.preferencesJson);
  const channels = { inApp: true, email: preferences.email };
  const results: Record<string, unknown> = {
    inApp: { status: "sent" },
  };

  if (!preferences.email) {
    results.email = {
      status: "skipped",
      reason: "user_preference_disabled",
    };
    await context.logger?.info(
      "notification_delivery_skipped",
      "Email delivery skipped by user preference",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        reason: "user_preference_disabled",
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "sent",
      channels,
      deliveryResults: results,
    });
  }

  const rawConfig = await readConfig(env, SYSTEM_NOTIFICATION_EMAIL_CONFIG_KEY);
  const config = normalizeNotificationEmailConfig(rawConfig);
  if (
    !config.enabled ||
    config.provider !== "resend" ||
    !config.fromEmail ||
    !config.resend.configured ||
    !config.resend.apiKeyEncrypted
  ) {
    results.email = {
      status: "skipped",
      reason: "system_email_unconfigured",
    };
    await context.logger?.info(
      "notification_delivery_skipped",
      "Email delivery skipped because system email is not configured",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        provider: "resend",
        reason: "system_email_unconfigured",
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "sent",
      channels,
      deliveryResults: results,
    });
  }

  if (!isValidEmail(user.email)) {
    results.email = {
      status: "skipped",
      reason: "recipient_email_invalid",
    };
    await context.logger?.warn(
      "notification_delivery_skipped",
      "Email delivery skipped because recipient email is invalid",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        provider: "resend",
        reason: "recipient_email_invalid",
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "sent",
      channels,
      deliveryResults: results,
    });
  }

  let apiKey = "";
  try {
    apiKey = await decryptNotificationSecret(
      env,
      config.resend.apiKeyEncrypted,
    );
  } catch {
    results.email = {
      status: "skipped",
      reason: "secret_decryption_failed",
    };
    await context.logger?.warn(
      "notification_delivery_skipped",
      "Email delivery skipped because saved credentials cannot be decrypted",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        provider: "resend",
        reason: "secret_decryption_failed",
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "sent",
      channels,
      deliveryResults: results,
    });
  }

  await context.logger?.info("notification_delivery_attempt", "Sending email", {
    messageId: message.id,
    userId: user.id,
    channel: "email",
    provider: "resend",
    recipient: maskEmail(user.email),
  });

  try {
    let rendered = fallbackRenderedEmail(message);
    try {
      const locale = resolveNotificationMessageLocale({
        messageLocale: message.data.locale,
        userLocale: user.preferredLocale,
      });
      rendered = await renderNotificationEmail({
        message,
        locale,
        timeZone: user.timeZone,
      });
    } catch (error) {
      await context.logger?.warn(
        "notification_email_render_failed",
        "Notification email render failed; falling back to plain text delivery",
        {
          messageId: message.id,
          userId: user.id,
          channel: "email",
          provider: "resend",
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const sendResult = await sendResendEmailWithRetry({
      apiKey,
      apiUrl:
        env.INSIGHTFLARE_E2E === "1"
          ? env.INSIGHTFLARE_E2E_RESEND_API_URL
          : undefined,
      fetchImpl: context.fetchImpl,
      requireApiUrl: env.INSIGHTFLARE_E2E === "1",
      body: {
        from: buildResendFromAddress(config),
        to: [user.email],
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        reply_to: config.replyTo || undefined,
      },
    });

    if (!sendResult.ok) {
      results.email = {
        status: "failed",
        provider: "resend",
        reason: sendResult.reason,
        errorMessage: sendResult.errorMessage,
        durationMs: sendResult.durationMs,
        attempts: sendResult.attempts,
        retryCount: sendResult.retryCount,
      };
      await context.logger?.error(
        "notification_delivery_failed",
        "Email delivery failed",
        {
          messageId: message.id,
          userId: user.id,
          channel: "email",
          provider: "resend",
          recipient: maskEmail(user.email),
          errorMessage: sendResult.errorMessage,
          durationMs: sendResult.durationMs,
          attempts: sendResult.attempts,
          retryCount: sendResult.retryCount,
        },
      );
      return updateNotificationDeliveryResult(env, {
        messageId: message.id,
        status: "failed",
        channels,
        deliveryResults: results,
        errorMessage: sendResult.errorMessage,
      });
    }
    results.email = {
      status: "sent",
      provider: "resend",
      messageId: sendResult.providerMessageId,
      durationMs: sendResult.durationMs,
      attempts: sendResult.attempts,
      retryCount: sendResult.retryCount,
    };
    await context.logger?.info(
      "notification_delivery_success",
      "Email delivery succeeded",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        provider: "resend",
        recipient: maskEmail(user.email),
        providerMessageId: sendResult.providerMessageId,
        durationMs: sendResult.durationMs,
        attempts: sendResult.attempts,
        retryCount: sendResult.retryCount,
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "sent",
      channels,
      deliveryResults: results,
    });
  } catch {
    const errorMessage = "Unable to reach Resend email API";
    results.email = {
      status: "failed",
      provider: "resend",
      reason: "network_failed",
      errorMessage,
      durationMs: 0,
      attempts: 0,
      retryCount: 0,
    };
    await context.logger?.error(
      "notification_delivery_failed",
      "Email delivery failed",
      {
        messageId: message.id,
        userId: user.id,
        channel: "email",
        provider: "resend",
        recipient: maskEmail(user.email),
        errorMessage,
        durationMs: 0,
      },
    );
    return updateNotificationDeliveryResult(env, {
      messageId: message.id,
      status: "failed",
      channels,
      deliveryResults: results,
      errorMessage,
    });
  }
}
