import type { Env } from "@/lib/edge/types";
import { safeJsonStringify } from "@/lib/notifications/json";
import type {
  NotificationChannel,
  NotificationMessageType,
} from "@/lib/notifications/message-types";

export interface NotificationPreferences {
  inApp: boolean;
  email: boolean;
  webPush: boolean;
  attention: {
    reportsCreateUnread: boolean;
    milestonesCreateUnread: boolean;
    alertsCreateUnread: boolean;
  };
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inApp: true,
  email: true,
  webPush: false,
  attention: {
    reportsCreateUnread: false,
    milestonesCreateUnread: false,
    alertsCreateUnread: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMaybeJson(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return {};
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeNotificationPreferences(
  input: unknown,
): NotificationPreferences {
  const raw = parseMaybeJson(input);
  if (!isRecord(raw)) return DEFAULT_NOTIFICATION_PREFERENCES;

  const attention = isRecord(raw.attention) ? raw.attention : {};
  const defaults = DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    inApp: true,
    email: booleanOr(raw.email, defaults.email),
    webPush: booleanOr(raw.webPush, defaults.webPush),
    attention: {
      reportsCreateUnread: booleanOr(
        attention.reportsCreateUnread,
        defaults.attention.reportsCreateUnread,
      ),
      milestonesCreateUnread: booleanOr(
        attention.milestonesCreateUnread,
        defaults.attention.milestonesCreateUnread,
      ),
      alertsCreateUnread: booleanOr(
        attention.alertsCreateUnread,
        defaults.attention.alertsCreateUnread,
      ),
    },
  };
}

export function mergeNotificationPreferencesUpdate(
  currentInput: unknown,
  updateInput: unknown,
): NotificationPreferences {
  const current = normalizeNotificationPreferences(currentInput);
  if (!isRecord(updateInput)) return current;
  const attention = isRecord(updateInput.attention)
    ? updateInput.attention
    : {};
  return {
    inApp: true,
    email: booleanOr(updateInput.email, current.email),
    webPush: current.webPush,
    attention: {
      reportsCreateUnread: booleanOr(
        attention.reportsCreateUnread,
        current.attention.reportsCreateUnread,
      ),
      milestonesCreateUnread: booleanOr(
        attention.milestonesCreateUnread,
        current.attention.milestonesCreateUnread,
      ),
      alertsCreateUnread: booleanOr(
        attention.alertsCreateUnread,
        current.attention.alertsCreateUnread,
      ),
    },
  };
}

export async function getUserNotificationPreferences(
  env: Env,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await env.DB.prepare(
    "SELECT notification_preferences_json AS preferencesJson FROM users WHERE id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ preferencesJson: string | null }>();
  return normalizeNotificationPreferences(row?.preferencesJson);
}

export async function updateUserNotificationPreferences(
  env: Env,
  input: { userId: string; preferences: unknown },
): Promise<NotificationPreferences> {
  const current = await getUserNotificationPreferences(env, input.userId);
  const next = mergeNotificationPreferencesUpdate(current, input.preferences);
  await env.DB.prepare(
    "UPDATE users SET notification_preferences_json = ?, updated_at = unixepoch() WHERE id = ?",
  )
    .bind(safeJsonStringify(next), input.userId)
    .run();
  return next;
}

export function isNotificationChannelEnabled(
  preferences: NotificationPreferences,
  channel: NotificationChannel,
): boolean {
  if (channel === "inApp") return true;
  if (channel === "email") return preferences.email;
  if (channel === "webPush") return preferences.webPush;
  return false;
}

export function shouldCreateUnreadAttention(input: {
  preferences: NotificationPreferences;
  type: NotificationMessageType;
  fallback: boolean;
}): boolean {
  if (input.type === "report") {
    return input.preferences.attention.reportsCreateUnread;
  }
  if (input.type === "milestone") {
    return input.preferences.attention.milestonesCreateUnread;
  }
  if (
    input.type === "threshold" ||
    input.type === "change" ||
    input.type === "health"
  ) {
    return input.preferences.attention.alertsCreateUnread;
  }
  return input.fallback;
}
