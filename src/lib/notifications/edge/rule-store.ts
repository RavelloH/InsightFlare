import {
  and,
  caseWhen,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  deleteFrom,
  distinct,
  eq,
  filter,
  inList,
  insert,
  inSubquery,
  isNotNull,
  isNull,
  join,
  limit,
  lte,
  neq,
  or,
  param,
  project,
  scan,
  schema,
  sort,
  update,
} from "@/lib/db";
import { canManageSite, canManageTeam } from "@/lib/edge/admin/access";
import type { Actor } from "@/lib/edge/admin/auth";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import {
  notificationRecipientRows,
  notificationRuleRows,
} from "@/lib/notifications/edge/database-projections";
import { safeJsonStringify, safeParseRecord } from "@/lib/notifications/json";
import {
  normalizeNotificationRuleType,
  type NotificationRuleType,
} from "@/lib/notifications/message-types";
import {
  computeNextNotificationRunAt,
  normalizeNotificationSchedule,
  type NotificationScheduleConfig,
} from "@/lib/notifications/schedule";
export type NotificationRecipientConfig =
  | { mode: "creator" }
  | { mode: "team_admins" }
  | { mode: "all_team_members" }
  | { mode: "users"; userIds: string[] };
export interface NotificationRule {
  id: string;
  teamId: string;
  siteId: string | null;
  name: string;
  description: string;
  type: NotificationRuleType;
  enabled: boolean;
  schedule: NotificationScheduleConfig;
  condition: Record<string, unknown>;
  recipient: NotificationRecipientConfig;
  state: Record<string, unknown>;
  lastCheckedAt: number | null;
  lastTriggeredAt: number | null;
  nextRunAt: number | null;
  cooldownUntil: number | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}
interface RuleRow {
  id: string;
  teamId: string;
  siteId: string | null;
  name: string;
  description: string | null;
  type: string;
  enabled: number;
  scheduleJson: string;
  conditionJson: string;
  recipientJson: string;
  stateJson?: string | null;
  lastCheckedAt: number | null;
  lastTriggeredAt: number | null;
  nextRunAt: number | null;
  cooldownUntil: number | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}
interface NotificationRuleStorageRow extends Omit<RuleRow, "id"> {
  id: string | null;
}
interface NotificationRecipient {
  id: string;
  email: string;
  preferencesJson: string;
  preferredLocale?: string | null;
  timeZone?: string | null;
}
interface NotificationRecipientStorageRow extends Omit<
  NotificationRecipient,
  "id"
> {
  id: string | null;
  email: string;
  preferencesJson: string;
}
export interface CreateNotificationRuleInput {
  teamId: string;
  siteId?: string | null;
  name: string;
  description?: string;
  type?: NotificationRuleType;
  enabled?: boolean;
  schedule?: unknown;
  condition?: Record<string, unknown>;
  recipient?: NotificationRecipientConfig;
}
export interface UpdateNotificationRuleInput {
  ruleId: string;
  teamId?: string;
  siteId?: string | null;
  name?: string;
  description?: string;
  type?: NotificationRuleType;
  enabled?: boolean;
  schedule?: unknown;
  condition?: Record<string, unknown>;
  recipient?: NotificationRecipientConfig;
}
function notificationRuleDatabase(env: Env) {
  return createD1DatabaseClient(env.DB);
}

function requireNotificationRuleRow(row: NotificationRuleStorageRow): RuleRow {
  if (typeof row.id !== "string") {
    throw new Error("notification_rule_row_missing_id");
  }
  return { ...row, id: row.id };
}

function requireNotificationRecipientRow(
  row: NotificationRecipientStorageRow,
): NotificationRecipient {
  if (typeof row.id !== "string" || typeof row.email !== "string") {
    throw new Error("notification_recipient_row_missing_identity");
  }
  if (
    typeof row.preferencesJson !== "string" ||
    (typeof row.preferredLocale !== "string" && row.preferredLocale !== null) ||
    (typeof row.timeZone !== "string" && row.timeZone !== null)
  ) {
    throw new Error("notification_recipient_row_invalid_preferences");
  }
  return {
    id: row.id,
    email: row.email,
    preferencesJson: row.preferencesJson,
    preferredLocale: row.preferredLocale,
    timeZone: row.timeZone,
  };
}
function cleanUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .map((item) => clampString(item, 120)),
    ),
  ).slice(0, 200);
}
export function normalizeNotificationRecipientConfig(
  input: unknown,
): NotificationRecipientConfig {
  const raw = safeParseRecord(input);
  if (raw.mode === "creator") return { mode: "creator" };
  if (raw.mode === "team_admins") return { mode: "team_admins" };
  if (raw.mode === "all_team_members") return { mode: "all_team_members" };
  if (raw.mode === "users") {
    return { mode: "users", userIds: cleanUserIds(raw.userIds) };
  }
  return { mode: "creator" };
}
export function mapNotificationRule(row: RuleRow): NotificationRule {
  return {
    id: String(row.id ?? ""),
    teamId: String(row.teamId ?? ""),
    siteId:
      row.siteId === null || row.siteId === undefined
        ? null
        : String(row.siteId),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    type: normalizeNotificationRuleType(row.type),
    enabled: Number(row.enabled ?? 0) === 1,
    schedule: normalizeNotificationSchedule(row.scheduleJson),
    condition: safeParseRecord(row.conditionJson),
    recipient: normalizeNotificationRecipientConfig(row.recipientJson),
    state: safeParseRecord(row.stateJson),
    lastCheckedAt:
      row.lastCheckedAt === null || row.lastCheckedAt === undefined
        ? null
        : Number(row.lastCheckedAt),
    lastTriggeredAt:
      row.lastTriggeredAt === null || row.lastTriggeredAt === undefined
        ? null
        : Number(row.lastTriggeredAt),
    nextRunAt:
      row.nextRunAt === null || row.nextRunAt === undefined
        ? null
        : Number(row.nextRunAt),
    cooldownUntil:
      row.cooldownUntil === null || row.cooldownUntil === undefined
        ? null
        : Number(row.cooldownUntil),
    createdByUserId:
      row.createdByUserId === null || row.createdByUserId === undefined
        ? null
        : String(row.createdByUserId),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
  };
}
export async function getNotificationRule(
  env: Env,
  ruleId: string,
): Promise<NotificationRule | null> {
  const selected = notificationRuleRows();
  const matching = filter(selected, eq(selected.columns.id, param(ruleId)));
  const row = await notificationRuleDatabase(env).first(
    compileD1Query(limit(matching, 1), {
      tag: "notifications.notification_rules.first",
    }),
  );
  return row ? mapNotificationRule(requireNotificationRuleRow(row)) : null;
}
async function requireCanManageRuleScope(
  env: Env,
  actor: Actor,
  input: { teamId: string; siteId?: string | null },
): Promise<boolean> {
  if (!(await canManageTeam(env, actor, input.teamId))) return false;
  if (input.siteId && !(await canManageSite(env, actor, input.siteId))) {
    return false;
  }
  return true;
}
export async function createNotificationRule(
  env: Env,
  actor: Actor,
  input: CreateNotificationRuleInput,
): Promise<NotificationRule> {
  if (!(await requireCanManageRuleScope(env, actor, input))) {
    throw new Error("Forbidden");
  }
  const now = Math.floor(appNow() / 1000);
  const id = crypto.randomUUID();
  const schedule = normalizeNotificationSchedule(input.schedule);
  const nextRunAt = computeNextNotificationRunAt(schedule, now);
  const type = normalizeNotificationRuleType(input.type ?? "test");
  const recipient = normalizeNotificationRecipientConfig(
    input.recipient ?? { mode: "creator" },
  );
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      insert(schema.notification_rules, {
        id,
        team_id: input.teamId,
        site_id: input.siteId ?? null,
        name: clampString(input.name.trim() || "Notification rule", 160),
        description: clampString((input.description ?? "").trim(), 1000),
        type,
        enabled: input.enabled === false ? 0 : 1,
        schedule_json: safeJsonStringify(schedule),
        condition_json: safeJsonStringify(input.condition ?? {}),
        recipient_json: safeJsonStringify(recipient),
        state_json: safeJsonStringify({}),
        next_run_at: nextRunAt,
        created_by_user_id: actor.user.id,
        created_at: now,
        updated_at: now,
      }),
      { tag: "notifications.rules.insert" },
    ),
  );
  const rule = await getNotificationRule(env, id);
  if (!rule) throw new Error("Notification rule was not created");
  return rule;
}
export async function listNotificationRules(
  env: Env,
  actor: Actor,
  filters: { teamId?: string; siteId?: string } = {},
): Promise<NotificationRule[]> {
  const rules = notificationRuleRows();
  const where = [];
  if (filters.teamId) {
    if (!(await canManageTeam(env, actor, filters.teamId))) {
      throw new Error("Forbidden");
    }
    where.push(eq(rules.columns.teamId, param(filters.teamId)));
  } else if (!actor.isAdmin) {
    const members = scan(schema.team_members);
    const teams = scan(schema.teams);
    const joined = join(
      members,
      teams,
      eq(members.columns.team_id, teams.columns.id),
      "left",
    );
    const manageableMemberships = filter(
      joined,
      and(
        eq(joined.columns.left_user_id, param(actor.user.id)),
        or(
          inList(joined.columns.left_role, ["owner", "admin"]),
          eq(joined.columns.right_owner_user_id, param(actor.user.id)),
        ),
      ),
    );
    const manageableTeamIds = project(manageableMemberships, {
      team_id: manageableMemberships.columns.left_team_id,
    });
    where.push(inSubquery(rules.columns.teamId, manageableTeamIds));
  }
  if (filters.siteId) {
    where.push(eq(rules.columns.siteId, param(filters.siteId)));
  }
  const matching =
    where.length === 0
      ? rules
      : filter(
          rules,
          where.length === 1 ? where[0]! : and(where[0]!, ...where.slice(1)),
        );
  const ordered = sort(matching, [
    { expression: matching.columns.updatedAt, direction: "DESC" },
  ]);
  const rows = await notificationRuleDatabase(env).all(
    compileD1Query(limit(ordered, 200), {
      tag: "notifications.notification_rules.all",
    }),
  );
  return rows.results.map((row) =>
    mapNotificationRule(requireNotificationRuleRow(row)),
  );
}
export async function updateNotificationRule(
  env: Env,
  actor: Actor,
  input: UpdateNotificationRuleInput,
): Promise<NotificationRule> {
  const current = await getNotificationRule(env, input.ruleId);
  if (!current) throw new Error("Not Found");
  const teamId = input.teamId ?? current.teamId;
  const siteId = Object.prototype.hasOwnProperty.call(input, "siteId")
    ? (input.siteId ?? null)
    : current.siteId;
  if (!(await requireCanManageRuleScope(env, actor, { teamId, siteId }))) {
    throw new Error("Forbidden");
  }
  const now = Math.floor(appNow() / 1000);
  const nextType =
    input.type !== undefined
      ? normalizeNotificationRuleType(input.type)
      : current.type;
  const nextCondition =
    input.condition !== undefined ? input.condition : current.condition;
  const schedule =
    input.schedule !== undefined
      ? normalizeNotificationSchedule(input.schedule)
      : current.schedule;
  const nextRunAt =
    input.schedule !== undefined
      ? computeNextNotificationRunAt(schedule, now)
      : current.nextRunAt;
  const recipient =
    input.recipient !== undefined
      ? normalizeNotificationRecipientConfig(input.recipient)
      : current.recipient;
  const stateShouldReset =
    nextType !== current.type ||
    siteId !== current.siteId ||
    safeJsonStringify(nextCondition) !== safeJsonStringify(current.condition);
  const nextState = stateShouldReset ? {} : current.state;
  const nextCooldownUntil = stateShouldReset ? null : current.cooldownUntil;
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      update(schema.notification_rules, (columns) => ({
        set: {
          team_id: teamId,
          site_id: siteId,
          name: clampString((input.name ?? current.name).trim(), 160),
          description: clampString(
            (input.description ?? current.description).trim(),
            1000,
          ),
          type: nextType,
          enabled: (input.enabled ?? current.enabled) ? 1 : 0,
          schedule_json: safeJsonStringify(schedule),
          condition_json: safeJsonStringify(nextCondition),
          recipient_json: safeJsonStringify(recipient),
          state_json: safeJsonStringify(nextState),
          cooldown_until: nextCooldownUntil,
          next_run_at: nextRunAt,
          updated_at: now,
        },
        where: eq(columns.id, param(input.ruleId)),
      })),
      { tag: "notifications.rules.update" },
    ),
  );
  const updated = await getNotificationRule(env, input.ruleId);
  if (!updated) throw new Error("Notification rule disappeared");
  return updated;
}
export async function deleteNotificationRule(
  env: Env,
  actor: Actor,
  ruleId: string,
): Promise<boolean> {
  const rule = await getNotificationRule(env, ruleId);
  if (!rule) return false;
  if (
    !(await requireCanManageRuleScope(env, actor, {
      teamId: rule.teamId,
      siteId: rule.siteId,
    }))
  ) {
    throw new Error("Forbidden");
  }
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      deleteFrom(schema.notification_rules, (columns) =>
        eq(columns.id, param(ruleId)),
      ),
      { tag: "notifications.rules.delete" },
    ),
  );
  return true;
}
export async function listDueNotificationRules(
  env: Env,
  now: number,
): Promise<NotificationRule[]> {
  const rules = notificationRuleRows();
  const matching = filter(
    rules,
    and(
      eq(rules.columns.enabled, param(1)),
      neq(rules.columns.type, param("test")),
      isNotNull(rules.columns.nextRunAt),
      lte(rules.columns.nextRunAt, param(now)),
      or(
        // Keep NULL cooldowns eligible and exclude only future cooldowns.
        isNull(rules.columns.cooldownUntil),
        lte(rules.columns.cooldownUntil, param(now)),
      ),
    ),
  );
  const ordered = sort(matching, [
    { expression: matching.columns.nextRunAt, direction: "ASC" },
  ]);
  const rows = await notificationRuleDatabase(env).all(
    compileD1Query(limit(ordered, 100), {
      tag: "notifications.notification_rules.all",
    }),
  );
  return rows.results.map((row) =>
    mapNotificationRule(requireNotificationRuleRow(row)),
  );
}
export async function advanceNotificationRuleSchedule(
  env: Env,
  input: {
    rule: NotificationRule;
    checkedAt: number;
    triggeredAt?: number | null;
    cooldownUntil?: number | null;
    state?: Record<string, unknown>;
  },
): Promise<void> {
  const nextRunAt = computeNextNotificationRunAt(
    input.rule.schedule,
    input.checkedAt,
  );
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      update(schema.notification_rules, (columns) => ({
        set: {
          last_checked_at: input.checkedAt,
          last_triggered_at: coalesce(
            param(input.triggeredAt ?? null),
            columns.last_triggered_at,
          ),
          next_run_at: nextRunAt,
          state_json: safeJsonStringify(input.state ?? input.rule.state),
          cooldown_until: caseWhen(
            [
              {
                when: isNotNull(param(input.cooldownUntil ?? null)),
                then: param(input.cooldownUntil ?? null),
              },
              {
                when: and(
                  isNotNull(columns.cooldown_until),
                  lte(columns.cooldown_until, param(input.checkedAt)),
                ),
                then: param(null),
              },
            ],
            columns.cooldown_until,
          ),
          updated_at: input.checkedAt,
        },
        where: eq(columns.id, param(input.rule.id)),
      })),
      { tag: "notifications.rules.advance_schedule" },
    ),
  );
}

export async function applyNotificationRuleManualRunResult(
  env: Env,
  input: {
    rule: NotificationRule;
    checkedAt: number;
    triggeredAt?: number | null;
    cooldownUntil?: number | null;
    state?: Record<string, unknown>;
  },
): Promise<void> {
  const shouldAdvanceNextRunAt =
    input.rule.nextRunAt === null || input.rule.nextRunAt <= input.checkedAt;
  const nextRunAt = shouldAdvanceNextRunAt
    ? computeNextNotificationRunAt(input.rule.schedule, input.checkedAt)
    : input.rule.nextRunAt;
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      update(schema.notification_rules, (columns) => ({
        set: {
          last_checked_at: input.checkedAt,
          last_triggered_at: coalesce(
            param(input.triggeredAt ?? null),
            columns.last_triggered_at,
          ),
          next_run_at: nextRunAt,
          state_json: safeJsonStringify(input.state ?? input.rule.state),
          cooldown_until: caseWhen(
            [
              {
                when: isNotNull(param(input.cooldownUntil ?? null)),
                then: param(input.cooldownUntil ?? null),
              },
              {
                when: and(
                  isNotNull(columns.cooldown_until),
                  lte(columns.cooldown_until, param(input.checkedAt)),
                ),
                then: param(null),
              },
            ],
            columns.cooldown_until,
          ),
          updated_at: input.checkedAt,
        },
        where: eq(columns.id, param(input.rule.id)),
      })),
      { tag: "notifications.rules.apply_manual_run" },
    ),
  );
}
export async function updateNotificationRuleState(
  env: Env,
  input: {
    ruleId: string;
    state: Record<string, unknown>;
    now?: number;
  },
): Promise<void> {
  const now = Math.trunc(input.now ?? appNow() / 1000);
  await notificationRuleDatabase(env).run(
    compileD1Mutation(
      update(schema.notification_rules, (columns) => ({
        set: {
          state_json: safeJsonStringify(input.state),
          updated_at: now,
        },
        where: eq(columns.id, param(input.ruleId)),
      })),
      { tag: "notifications.rules.update_state" },
    ),
  );
}
export async function resolveNotificationRecipients(
  env: Env,
  rule: NotificationRule,
): Promise<NotificationRecipient[]> {
  const database = notificationRuleDatabase(env);
  if (rule.recipient.mode === "creator") {
    if (!rule.createdByUserId) return [];
    const users = notificationRecipientRows();
    const creator = filter(
      users,
      eq(users.columns.id, param(rule.createdByUserId)),
    );
    const row = await database.first(
      compileD1Query(limit(creator, 1), { tag: "notifications.users.first" }),
    );
    return row ? [requireNotificationRecipientRow(row)] : [];
  }
  if (rule.recipient.mode === "users") {
    if (rule.recipient.userIds.length === 0) return [];
    const users = notificationRecipientRows();
    const recipients: NotificationRecipient[] = [];
    for (let offset = 0; offset < rule.recipient.userIds.length; offset += 90) {
      const chunk = rule.recipient.userIds.slice(offset, offset + 90);
      const selected = filter(users, inList(users.columns.id, chunk));
      const rows = await database.all(
        compileD1Query(selected, { tag: "notifications.users.all" }),
      );
      recipients.push(...rows.results.map(requireNotificationRecipientRow));
    }
    return recipients;
  }
  const users = notificationRecipientRows();
  const members = scan(schema.team_members);
  const teams = scan(schema.teams);
  const userRecords = scan(schema.users);
  const recipientsWithUserRecord = join(
    users,
    userRecords,
    eq(users.columns.id, userRecords.columns.id),
  );
  const userMemberships = join(
    recipientsWithUserRecord,
    members,
    eq(recipientsWithUserRecord.columns.left_id, members.columns.user_id),
  );
  const teamUserMemberships = join(
    userMemberships,
    teams,
    eq(userMemberships.columns.right_team_id, teams.columns.id),
  );
  const teamCondition = eq(
    teamUserMemberships.columns.left_right_team_id,
    param(rule.teamId),
  );
  const matching = filter(
    teamUserMemberships,
    rule.recipient.mode === "team_admins"
      ? and(
          teamCondition,
          or(
            inList(teamUserMemberships.columns.left_right_role, [
              "owner",
              "admin",
            ]),
            eq(
              teamUserMemberships.columns.right_owner_user_id,
              teamUserMemberships.columns.left_left_left_id,
            ),
          ),
        )
      : teamCondition,
  );
  const withOrdering = project(matching, {
    id: matching.columns.left_left_left_id,
    email: matching.columns.left_left_left_email,
    preferencesJson: matching.columns.left_left_left_preferencesJson,
    preferredLocale: matching.columns.left_left_left_preferredLocale,
    timeZone: matching.columns.left_left_left_timeZone,
    createdAt: matching.columns.left_left_right_created_at,
  });
  const uniqueRecipients = distinct(withOrdering);
  const orderedDistinct = sort(uniqueRecipients, [
    { expression: uniqueRecipients.columns.createdAt, direction: "ASC" },
  ]);
  const rows = await database.all(
    compileD1Query(orderedDistinct, { tag: "notifications.users.all" }),
  );
  return rows.results.map((row) => {
    const { createdAt: _createdAt, ...recipient } = row;
    return requireNotificationRecipientRow(recipient);
  });
}
