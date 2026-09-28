import {
  aggregate,
  and,
  caseWhen,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  count,
  createD1DatabaseClient,
  eq,
  filter,
  gt,
  insert,
  isNull,
  limit,
  lt,
  or,
  param,
  sort,
  update,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import { safeJsonStringify, safeParseRecord } from "@/lib/notifications/json";
import type { NotificationMessage } from "@/lib/notifications/message";
import {
  defaultRequiresAttention,
  normalizeNotificationDeliveryStatus,
  normalizeNotificationMessageType,
  normalizeNotificationSeverity,
  type NotificationDeliveryStatus,
  type NotificationMessageType,
  type NotificationSeverity,
} from "@/lib/notifications/message-types";
import { notificationRuleExpiresAtSeconds } from "@/lib/notifications/schedule";
import type { ScheduledTaskRetentionConfig } from "@/lib/scheduled-tasks";

import { notificationMessageRows } from "./database-projections";
type MessageProjection = ReturnType<typeof notificationMessageRows>;
type MessageRow = NonNullable<MessageProjection["__row"]>;
type RefinedMessageRow = Omit<MessageRow, "id"> & { id: string };
type ExpiryColumn = MessageProjection["columns"]["expiresAt"];

function requireNotificationMessageRow(row: MessageRow): RefinedMessageRow {
  if (typeof row.id !== "string") {
    throw new Error("notification_message_row_invalid_id");
  }
  return { ...row, id: row.id };
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
function messageHasNotExpired(expiresAt: ExpiryColumn, now: number) {
  return or(isNull(expiresAt), gt(expiresAt, param(now)));
}

function messageByIdQuery(
  messageId: string,
  options: { includeExpired?: boolean; now?: number } = {},
) {
  const messages = notificationMessageRows();
  const predicates = [eq(messages.columns.id, param(messageId))];
  if (!options.includeExpired) {
    predicates.push(
      messageHasNotExpired(
        messages.columns.expiresAt,
        Math.trunc(options.now ?? appNow() / 1000),
      ),
    );
  }
  const predicate =
    predicates.length === 1
      ? predicates[0]!
      : and(predicates[0]!, ...predicates.slice(1));
  const matching = filter(messages, predicate);
  return limit(matching, 1);
}

function createListQuery(input: {
  ownerColumn: "userId" | "teamId";
  ownerId: string;
  otherFilters: ListNotificationMessagesInput;
  limit: number;
  now: number;
}) {
  const messages = notificationMessageRows();
  const predicates = [
    eq(messages.columns[input.ownerColumn], param(input.ownerId)),
    isNull(messages.columns.archivedAt),
    messageHasNotExpired(messages.columns.expiresAt, input.now),
  ];
  if (input.ownerColumn === "userId" && input.otherFilters.teamId) {
    predicates.push(
      eq(messages.columns.teamId, param(input.otherFilters.teamId)),
    );
  } else if (input.ownerColumn === "teamId" && input.otherFilters.userId) {
    predicates.push(
      eq(messages.columns.userId, param(input.otherFilters.userId)),
    );
  }
  if (input.otherFilters.siteId) {
    predicates.push(
      eq(messages.columns.siteId, param(input.otherFilters.siteId)),
    );
  }
  if (input.otherFilters.ruleId) {
    predicates.push(
      eq(messages.columns.ruleId, param(input.otherFilters.ruleId)),
    );
  }
  if (input.otherFilters.type) {
    predicates.push(eq(messages.columns.type, param(input.otherFilters.type)));
  }
  if (input.otherFilters.severity) {
    predicates.push(
      eq(messages.columns.severity, param(input.otherFilters.severity)),
    );
  }
  if (input.otherFilters.unread) {
    predicates.push(isNull(messages.columns.readAt));
  }
  if (input.otherFilters.before) {
    predicates.push(
      lt(
        messages.columns.createdAt,
        param(Math.trunc(input.otherFilters.before)),
      ),
    );
  }

  const matching = filter(
    messages,
    and(predicates[0]!, ...predicates.slice(1)),
  );
  return limit(
    sort(matching, [
      { expression: matching.columns.createdAt, direction: "DESC" },
    ]),
    input.limit,
  );
}
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
  const row = await createD1DatabaseClient(env.DB).first<MessageRow>(
    compileD1Query(messageByIdQuery(messageId, options), {
      tag: "notifications.notification_messages.first",
    }),
  );
  return row
    ? mapNotificationMessage(requireNotificationMessageRow(row))
    : null;
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

  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      insert(schema.notification_messages, {
        id,
        team_id: input.teamId,
        site_id: input.siteId ?? null,
        user_id: input.userId,
        rule_id: input.ruleId ?? null,
        run_id: input.runId ?? null,
        batch_id: input.batchId ?? null,
        type,
        severity,
        requires_attention: requiresAttention ? 1 : 0,
        title: clampString(input.title.trim(), 240),
        summary: clampString((input.summary ?? "").trim(), 500),
        body_text: clampString((input.bodyText ?? "").trim(), 4000),
        body_html: clampString((input.bodyHtml ?? "").trim(), 12000),
        data_json: safeJsonStringify(input.data ?? {}),
        channels_json: safeJsonStringify(input.channels ?? { inApp: true }),
        delivery_status: deliveryStatus,
        delivery_results_json: safeJsonStringify(input.deliveryResults ?? {}),
        triggered_at: input.triggeredAt ?? now,
        created_at: now,
        updated_at: now,
        sent_at: deliveryStatus === "sent" ? now : null,
        failed_at: deliveryStatus === "failed" ? now : null,
        expires_at: expiresAt,
      }),
      { tag: "notifications.messages.insert" },
    ),
  );

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
  const rows = await createD1DatabaseClient(env.DB).all<MessageRow>(
    compileD1Query(
      createListQuery({
        ownerColumn: "userId",
        ownerId: input.userId,
        otherFilters: input,
        limit,
        now,
      }),
      { tag: "notifications.notification_messages.all" },
    ),
  );
  return rows.results.map((row) =>
    mapNotificationMessage(requireNotificationMessageRow(row)),
  );
}
export async function listNotificationMessagesForTeam(
  env: Env,
  input: ListNotificationMessagesInput & { teamId: string },
): Promise<NotificationMessage[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const now = Math.trunc(appNow() / 1000);
  const rows = await createD1DatabaseClient(env.DB).all<MessageRow>(
    compileD1Query(
      createListQuery({
        ownerColumn: "teamId",
        ownerId: input.teamId,
        otherFilters: input,
        limit,
        now,
      }),
      { tag: "notifications.notification_messages.all" },
    ),
  );
  return rows.results.map((row) =>
    mapNotificationMessage(requireNotificationMessageRow(row)),
  );
}
export async function countUnreadAttentionMessages(
  env: Env,
  userId: string,
): Promise<number> {
  const messages = notificationMessageRows();
  const unreadAttention = filter(
    messages,
    and(
      eq(messages.columns.userId, param(userId)),
      eq(messages.columns.requiresAttention, param(1)),
      isNull(messages.columns.readAt),
      isNull(messages.columns.archivedAt),
      messageHasNotExpired(
        messages.columns.expiresAt,
        Math.trunc(appNow() / 1000),
      ),
    ),
  );
  const row = await createD1DatabaseClient(env.DB).first<{ count: number }>(
    compileD1Query(
      aggregate(unreadAttention, {
        groupBy: {},
        aggregates: { count: count() },
      }),
      { tag: "notifications.notification_messages.first" },
    ),
  );
  return Number(row?.count ?? 0);
}
export async function markNotificationMessageRead(
  env: Env,
  input: { messageId: string; userId: string; now?: number },
): Promise<NotificationMessage | null> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  const client = createD1DatabaseClient(env.DB);
  await client.run(
    compileD1Mutation(
      update(schema.notification_messages, (columns) => ({
        set: {
          read_at: coalesce(columns.read_at, param(now)),
          updated_at: param(now),
        },
        where: and(
          eq(columns.id, param(input.messageId)),
          eq(columns.user_id, param(input.userId)),
          messageHasNotExpired(columns.expires_at, now),
        ),
      })),
      { tag: "notifications.messages.mark_read" },
    ),
  );
  const row = await client.first<MessageRow>(
    compileD1Query(messageByIdQuery(input.messageId, { now }), {
      tag: "notifications.notification_messages.first",
    }),
  );
  return row
    ? mapNotificationMessage(requireNotificationMessageRow(row))
    : null;
}
export async function markAllNotificationMessagesRead(
  env: Env,
  input: { userId: string; teamId?: string; now?: number },
): Promise<number> {
  const now = Math.trunc(input.now ?? Date.now() / 1000);
  const result = await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      update(schema.notification_messages, (columns) => ({
        set: {
          read_at: coalesce(columns.read_at, param(now)),
          updated_at: param(now),
        },
        where: and(
          eq(columns.user_id, param(input.userId)),
          ...(input.teamId ? [eq(columns.team_id, param(input.teamId))] : []),
          isNull(columns.read_at),
          messageHasNotExpired(columns.expires_at, now),
        ),
      })),
      {
        tag: input.teamId
          ? "notifications.messages.mark_all_read_for_team"
          : "notifications.messages.mark_all_read",
      },
    ),
  );
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
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      update(schema.notification_messages, (columns) => ({
        set: {
          delivery_status: status,
          delivery_results_json: safeJsonStringify(input.deliveryResults),
          channels_json: coalesce(
            param(input.channels ? safeJsonStringify(input.channels) : null),
            columns.channels_json,
          ),
          error_message: clampString(input.errorMessage ?? "", 1000),
          updated_at: now,
          sent_at: caseWhen(
            [
              {
                when: eq(param(status), param("sent")),
                then: coalesce(columns.sent_at, param(now)),
              },
            ],
            columns.sent_at,
          ),
          failed_at: caseWhen(
            [
              {
                when: eq(param(status), param("failed")),
                then: coalesce(columns.failed_at, param(now)),
              },
            ],
            columns.failed_at,
          ),
        },
        where: eq(columns.id, param(input.messageId)),
      })),
      { tag: "notifications.messages.update_delivery_result" },
    ),
  );
  return getNotificationMessage(env, input.messageId);
}
