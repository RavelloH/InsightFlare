import { appNow } from "@/lib/edge/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import type { ScheduledTaskRetentionConfig } from "@/lib/scheduled-tasks";

import { safeJsonStringify, safeParseRecord } from "./json";
import {
  defaultRequiresAttention,
  normalizeNotificationDeliveryStatus,
  normalizeNotificationMessageType,
  normalizeNotificationSeverity,
  type NotificationDeliveryStatus,
  type NotificationMessageType,
  type NotificationSeverity,
} from "./message-types";
import { notificationRuleExpiresAtSeconds } from "./schedule";

export interface NotificationMessage {
  id: string;
  teamId: string;
  siteId: string | null;
  userId: string;
  ruleId: string | null;
  runId: string | null;
  batchId: string | null;
  type: NotificationMessageType;
  severity: NotificationSeverity;
  requiresAttention: boolean;
  title: string;
  summary: string;
  bodyText: string;
  bodyHtml: string;
  data: Record<string, unknown>;
  channels: Record<string, unknown>;
  deliveryStatus: NotificationDeliveryStatus;
  deliveryResults: Record<string, unknown>;
  errorMessage: string;
  readAt: number | null;
  dismissedAt: number | null;
  archivedAt: number | null;
  triggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  failedAt: number | null;
  expiresAt: number | null;
}

interface MessageRow {
  id: string;
  teamId: string;
  siteId: string | null;
  userId: string;
  ruleId: string | null;
  runId: string | null;
  batchId: string | null;
  type: string;
  severity: string;
  requiresAttention: number;
  title: string;
  summary: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  dataJson: string;
  channelsJson: string;
  deliveryStatus: string;
  deliveryResultsJson: string;
  errorMessage: string | null;
  readAt: number | null;
  dismissedAt: number | null;
  archivedAt: number | null;
  triggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  failedAt: number | null;
  expiresAt: number | null;
}

export interface CreateNotificationMessageInput {
  teamId: string;
  siteId?: string | null;
  userId: string;
  ruleId?: string | null;
  runId?: string | null;
  batchId?: string | null;
  type: NotificationMessageType;
  severity?: NotificationSeverity;
  requiresAttention?: boolean;
  title: string;
  summary?: string;
  bodyText?: string;
  bodyHtml?: string;
  data?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  deliveryStatus?: NotificationDeliveryStatus;
  deliveryResults?: Record<string, unknown>;
  triggeredAt?: number | null;
  now?: number;
  retention?: ScheduledTaskRetentionConfig;
}

export interface ListNotificationMessagesInput {
  userId?: string;
  teamId?: string;
  siteId?: string;
  ruleId?: string;
  type?: string;
  severity?: string;
  unread?: boolean;
  limit?: number;
  before?: number;
}

const MESSAGE_SELECT = `
  id,
  team_id AS teamId,
  site_id AS siteId,
  user_id AS userId,
  rule_id AS ruleId,
  run_id AS runId,
  batch_id AS batchId,
  type,
  severity,
  requires_attention AS requiresAttention,
  title,
  summary,
  body_text AS bodyText,
  body_html AS bodyHtml,
  data_json AS dataJson,
  channels_json AS channelsJson,
  delivery_status AS deliveryStatus,
  delivery_results_json AS deliveryResultsJson,
  error_message AS errorMessage,
  read_at AS readAt,
  dismissed_at AS dismissedAt,
  archived_at AS archivedAt,
  triggered_at AS triggeredAt,
  created_at AS createdAt,
  updated_at AS updatedAt,
  sent_at AS sentAt,
  failed_at AS failedAt,
  expires_at AS expiresAt
`;

export function mapNotificationMessage(row: MessageRow): NotificationMessage {
  return {
    id: String(row.id ?? ""),
    teamId: String(row.teamId ?? ""),
    siteId:
      row.siteId === null || row.siteId === undefined
        ? null
        : String(row.siteId),
    userId: String(row.userId ?? ""),
    ruleId:
      row.ruleId === null || row.ruleId === undefined
        ? null
        : String(row.ruleId),
    runId:
      row.runId === null || row.runId === undefined ? null : String(row.runId),
    batchId:
      row.batchId === null || row.batchId === undefined
        ? null
        : String(row.batchId),
    type: normalizeNotificationMessageType(row.type),
    severity: normalizeNotificationSeverity(row.severity),
    requiresAttention: Number(row.requiresAttention ?? 0) === 1,
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    bodyText: String(row.bodyText ?? ""),
    bodyHtml: String(row.bodyHtml ?? ""),
    data: safeParseRecord(row.dataJson),
    channels: safeParseRecord(row.channelsJson),
    deliveryStatus: normalizeNotificationDeliveryStatus(row.deliveryStatus),
    deliveryResults: safeParseRecord(row.deliveryResultsJson),
    errorMessage: String(row.errorMessage ?? ""),
    readAt:
      row.readAt === null || row.readAt === undefined
        ? null
        : Number(row.readAt),
    dismissedAt:
      row.dismissedAt === null || row.dismissedAt === undefined
        ? null
        : Number(row.dismissedAt),
    archivedAt:
      row.archivedAt === null || row.archivedAt === undefined
        ? null
        : Number(row.archivedAt),
    triggeredAt:
      row.triggeredAt === null || row.triggeredAt === undefined
        ? null
        : Number(row.triggeredAt),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    sentAt:
      row.sentAt === null || row.sentAt === undefined
        ? null
        : Number(row.sentAt),
    failedAt:
      row.failedAt === null || row.failedAt === undefined
        ? null
        : Number(row.failedAt),
    expiresAt:
      row.expiresAt === null || row.expiresAt === undefined
        ? null
        : Number(row.expiresAt),
  };
}

export async function getNotificationMessage(
  env: Env,
  messageId: string,
  options: { includeExpired?: boolean } = {},
): Promise<NotificationMessage | null> {
  const expiryFilter = options.includeExpired
    ? ""
    : " AND (expires_at IS NULL OR expires_at > ?)";
  const statement = env.DB.prepare(
    `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE id=?${expiryFilter} LIMIT 1`,
  );
  const row = options.includeExpired
    ? await statement.bind(messageId).first<MessageRow>()
    : await statement
        .bind(messageId, Math.trunc(appNow() / 1000))
        .first<MessageRow>();
  return row ? mapNotificationMessage(row) : null;
}

export async function createNotificationMessage(
  env: Env,
  input: CreateNotificationMessageInput,
): Promise<NotificationMessage> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  const id = crypto.randomUUID();
  const type = normalizeNotificationMessageType(input.type);
  const severity = normalizeNotificationSeverity(input.severity);
  const requiresAttention =
    input.requiresAttention ?? defaultRequiresAttention({ type, severity });
  const deliveryStatus = normalizeNotificationDeliveryStatus(
    input.deliveryStatus ?? "created",
  );
  const expiresAt = notificationRuleExpiresAtSeconds({
    type,
    severity,
    createdAtSeconds: now,
    retention: input.retention,
  });

  await env.DB.prepare(
    `
      INSERT INTO notification_messages (
        id, team_id, site_id, user_id, rule_id, run_id, batch_id,
        type, severity, requires_attention, title, summary, body_text,
        body_html, data_json, channels_json, delivery_status,
        delivery_results_json, triggered_at, created_at, updated_at,
        sent_at, failed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      id,
      input.teamId,
      input.siteId ?? null,
      input.userId,
      input.ruleId ?? null,
      input.runId ?? null,
      input.batchId ?? null,
      type,
      severity,
      requiresAttention ? 1 : 0,
      clampString(input.title.trim(), 240),
      clampString((input.summary ?? "").trim(), 500),
      clampString((input.bodyText ?? "").trim(), 4000),
      clampString((input.bodyHtml ?? "").trim(), 12000),
      safeJsonStringify(input.data ?? {}),
      safeJsonStringify(input.channels ?? { inApp: true }),
      deliveryStatus,
      safeJsonStringify(input.deliveryResults ?? {}),
      input.triggeredAt ?? now,
      now,
      now,
      deliveryStatus === "sent" ? now : null,
      deliveryStatus === "failed" ? now : null,
      expiresAt,
    )
    .run();

  const message = await getNotificationMessage(env, id, {
    includeExpired: true,
  });
  if (!message) throw new Error("Notification message was not created");
  return message;
}

export async function listNotificationMessagesForUser(
  env: Env,
  input: ListNotificationMessagesInput & { userId: string },
): Promise<NotificationMessage[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const now = Math.trunc(appNow() / 1000);
  const filters = [
    "user_id = ?",
    "archived_at IS NULL",
    "(expires_at IS NULL OR expires_at > ?)",
  ];
  const bindings: Array<string | number> = [input.userId, now];
  if (input.teamId) {
    filters.push("team_id = ?");
    bindings.push(input.teamId);
  }
  if (input.siteId) {
    filters.push("site_id = ?");
    bindings.push(input.siteId);
  }
  if (input.ruleId) {
    filters.push("rule_id = ?");
    bindings.push(input.ruleId);
  }
  if (input.type) {
    filters.push("type = ?");
    bindings.push(input.type);
  }
  if (input.severity) {
    filters.push("severity = ?");
    bindings.push(input.severity);
  }
  if (input.unread) {
    filters.push("read_at IS NULL");
  }
  if (input.before) {
    filters.push("created_at < ?");
    bindings.push(Math.trunc(input.before));
  }
  const rows = await env.DB.prepare(
    `
      SELECT ${MESSAGE_SELECT}
      FROM notification_messages
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `,
  )
    .bind(...bindings, limit)
    .all<MessageRow>();
  return rows.results.map(mapNotificationMessage);
}

export async function listNotificationMessagesForTeam(
  env: Env,
  input: ListNotificationMessagesInput & { teamId: string },
): Promise<NotificationMessage[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const now = Math.trunc(appNow() / 1000);
  const filters = [
    "team_id = ?",
    "archived_at IS NULL",
    "(expires_at IS NULL OR expires_at > ?)",
  ];
  const bindings: Array<string | number> = [input.teamId, now];
  if (input.userId) {
    filters.push("user_id = ?");
    bindings.push(input.userId);
  }
  if (input.siteId) {
    filters.push("site_id = ?");
    bindings.push(input.siteId);
  }
  if (input.ruleId) {
    filters.push("rule_id = ?");
    bindings.push(input.ruleId);
  }
  if (input.type) {
    filters.push("type = ?");
    bindings.push(input.type);
  }
  if (input.severity) {
    filters.push("severity = ?");
    bindings.push(input.severity);
  }
  if (input.unread) {
    filters.push("read_at IS NULL");
  }
  if (input.before) {
    filters.push("created_at < ?");
    bindings.push(Math.trunc(input.before));
  }
  const rows = await env.DB.prepare(
    `
      SELECT ${MESSAGE_SELECT}
      FROM notification_messages
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `,
  )
    .bind(...bindings, limit)
    .all<MessageRow>();
  return rows.results.map(mapNotificationMessage);
}

export async function countUnreadAttentionMessages(
  env: Env,
  userId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `
      SELECT COUNT(*) AS count
      FROM notification_messages
      WHERE user_id=?
        AND requires_attention=1
        AND read_at IS NULL
        AND archived_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `,
  )
    .bind(userId, Math.trunc(appNow() / 1000))
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function markNotificationMessageRead(
  env: Env,
  input: { messageId: string; userId: string; now?: number },
): Promise<NotificationMessage | null> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  await env.DB.prepare(
    `
      UPDATE notification_messages
      SET read_at = COALESCE(read_at, ?), updated_at = ?
      WHERE id = ? AND user_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `,
  )
    .bind(now, now, input.messageId, input.userId, now)
    .run();
  const row = await env.DB.prepare(
    `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
  )
    .bind(input.messageId, input.userId, now)
    .first<MessageRow>();
  return row ? mapNotificationMessage(row) : null;
}

export async function markAllNotificationMessagesRead(
  env: Env,
  input: { userId: string; teamId?: string; now?: number },
): Promise<number> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  if (input.teamId) {
    const result = await env.DB.prepare(
      `
        UPDATE notification_messages
        SET read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE user_id = ? AND team_id = ? AND read_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `,
    )
      .bind(now, now, input.userId, input.teamId, now)
      .run();
    return Number(result.meta?.changes ?? 0);
  }
  const result = await env.DB.prepare(
    `
      UPDATE notification_messages
      SET read_at = COALESCE(read_at, ?), updated_at = ?
      WHERE user_id = ? AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `,
  )
    .bind(now, now, input.userId, now)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function updateNotificationDeliveryResult(
  env: Env,
  input: {
    messageId: string;
    status: NotificationDeliveryStatus;
    deliveryResults: Record<string, unknown>;
    channels?: Record<string, unknown>;
    errorMessage?: string;
    now?: number;
  },
): Promise<NotificationMessage | null> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  const status = normalizeNotificationDeliveryStatus(input.status);
  await env.DB.prepare(
    `
      UPDATE notification_messages
      SET
        delivery_status = ?,
        delivery_results_json = ?,
        channels_json = COALESCE(?, channels_json),
        error_message = ?,
        updated_at = ?,
        sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
        failed_at = CASE WHEN ? = 'failed' THEN COALESCE(failed_at, ?) ELSE failed_at END
      WHERE id = ?
    `,
  )
    .bind(
      status,
      safeJsonStringify(input.deliveryResults),
      input.channels ? safeJsonStringify(input.channels) : null,
      clampString(input.errorMessage ?? "", 1000),
      now,
      status,
      now,
      status,
      now,
      input.messageId,
    )
    .run();
  return getNotificationMessage(env, input.messageId);
}
