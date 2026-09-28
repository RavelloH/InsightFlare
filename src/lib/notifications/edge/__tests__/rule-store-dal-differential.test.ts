import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";
import type { NotificationRule } from "@/lib/notifications/edge/rule-store";
import {
  advanceNotificationRuleSchedule,
  applyNotificationRuleManualRunResult,
  createNotificationRule,
  deleteNotificationRule,
  getNotificationRule,
  listDueNotificationRules,
  listNotificationRules,
  normalizeNotificationRecipientConfig,
  resolveNotificationRecipients,
  updateNotificationRule,
  updateNotificationRuleState,
} from "@/lib/notifications/edge/rule-store";
import { computeNextNotificationRunAt } from "@/lib/notifications/schedule";

interface LegacyRuleRow {
  readonly id: string;
  readonly teamId: string;
  readonly siteId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly enabled: number;
  readonly scheduleJson: string;
  readonly conditionJson: string;
  readonly recipientJson: string;
  readonly stateJson: string;
  readonly lastCheckedAt: number | null;
  readonly lastTriggeredAt: number | null;
  readonly nextRunAt: number | null;
  readonly cooldownUntil: number | null;
  readonly createdByUserId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface LegacyRecipientRow {
  readonly id: string;
  readonly email: string;
  readonly preferencesJson: string;
  readonly preferredLocale: string | null;
  readonly timeZone: string | null;
}

const databases = new Set<DatabaseSync>();

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };

  const insertUser = database.prepare(
    "INSERT INTO users (id, email, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertUser.run("owner-1", "owner-1@example.test", "owner-1", 10, 10);
  insertUser.run("owner-2", "owner-2@example.test", "owner-2", 20, 20);
  insertUser.run("member-1", "member-1@example.test", "member-1", 30, 30);
  insertUser.run("admin-1", "admin-1@example.test", "admin-1", 40, 40);
  insertUser.run(
    "restricted-1",
    "restricted-1@example.test",
    "restricted-1",
    50,
    50,
  );
  insertUser.run("role-owner", "role-owner@example.test", "role-owner", 60, 60);
  insertUser.run(
    "unrelated-1",
    "unrelated@example.test",
    "unrelated-1",
    70,
    70,
  );

  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertTeam.run("team-1", "Team One", "team-one", "owner-1", 1);
  insertTeam.run("team-2", "Team Two", "team-two", "owner-2", 2);
  insertTeam.run("team-3", "Team Three", "team-three", "owner-2", 3);

  const insertMembership = database.prepare(
    "INSERT INTO team_members (team_id, user_id, role, site_ids_json) VALUES (?, ?, ?, ?)",
  );
  // Team owner is included by the legacy owner_user_id branch even with a
  // non-admin membership role.
  insertMembership.run("team-1", "owner-1", "member", "[]");
  insertMembership.run("team-2", "owner-1", "admin", "[]");
  insertMembership.run("team-3", "owner-1", "member", "[]");
  insertMembership.run("team-1", "role-owner", "owner", "[]");
  insertMembership.run("team-1", "admin-1", "admin", "[]");
  insertMembership.run("team-1", "member-1", "member", "[]");
  insertMembership.run("team-1", "restricted-1", "member", '["site-other"]');
  // One user has memberships in separate teams; resolving team-1 must not
  // duplicate or leak that user's team-2 membership.
  insertMembership.run("team-2", "admin-1", "member", "[]");

  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
    )
    .run("site-1", "team-1", "Site One", "one.example.test");

  const env = {
    DB: createSqliteD1Database(database, trace),
  } as unknown as Env;
  return { database, env, trace };
}

function insertLegacyRule(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly teamId?: string;
    readonly siteId?: string | null;
    readonly type?: string;
    readonly enabled?: number;
    readonly nextRunAt?: number | null;
    readonly cooldownUntil?: number | null;
    readonly updatedAt?: number;
    readonly stateJson?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO notification_rules (
         id, team_id, site_id, name, description, type, enabled,
         schedule_json, condition_json, recipient_json, state_json,
         next_run_at, cooldown_until, created_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.teamId ?? "team-1",
      input.siteId ?? null,
      input.id,
      "",
      input.type ?? "threshold",
      input.enabled ?? 1,
      JSON.stringify({ kind: "interval", everyMinutes: 60 }),
      "{}",
      JSON.stringify({ mode: "creator" }),
      input.stateJson ?? "{}",
      input.nextRunAt ?? null,
      input.cooldownUntil ?? null,
      "owner-1",
      10,
      input.updatedAt ?? 10,
    );
}

function makeRecipientRule(
  recipient: NotificationRule["recipient"],
  input: {
    readonly createdByUserId?: string | null;
    readonly teamId?: string;
  } = {},
): NotificationRule {
  return {
    id: "recipient-rule",
    teamId: input.teamId ?? "team-1",
    siteId: null,
    name: "Recipient rule",
    description: "",
    type: "threshold",
    enabled: true,
    schedule: { kind: "interval", everyMinutes: 60 },
    condition: {},
    recipient,
    state: {},
    lastCheckedAt: null,
    lastTriggeredAt: null,
    nextRunAt: null,
    cooldownUntil: null,
    createdByUserId: input.createdByUserId ?? null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const LEGACY_SELECT = `
  SELECT id, team_id AS teamId, site_id AS siteId, name, description, type,
         enabled, schedule_json AS scheduleJson,
         condition_json AS conditionJson, recipient_json AS recipientJson,
         state_json AS stateJson, last_checked_at AS lastCheckedAt,
         last_triggered_at AS lastTriggeredAt, next_run_at AS nextRunAt,
         cooldown_until AS cooldownUntil,
         created_by_user_id AS createdByUserId, created_at AS createdAt,
         updated_at AS updatedAt
  FROM notification_rules
`;

function legacyGet(database: DatabaseSync, id: string): LegacyRuleRow | null {
  return (
    (database.prepare(`${LEGACY_SELECT} WHERE id = ? LIMIT 1`).get(id) as
      LegacyRuleRow | undefined) ?? null
  );
}

function legacyList(
  database: DatabaseSync,
  where = "",
  bindings: readonly (string | number)[] = [],
): LegacyRuleRow[] {
  return database
    .prepare(`${LEGACY_SELECT} ${where} ORDER BY updated_at DESC LIMIT 200`)
    .all(...bindings) as unknown as LegacyRuleRow[];
}

function legacyDue(database: DatabaseSync, now: number): LegacyRuleRow[] {
  return database
    .prepare(
      `${LEGACY_SELECT}
       WHERE enabled = 1 AND type != 'test' AND next_run_at IS NOT NULL
         AND next_run_at <= ?
         AND (cooldown_until IS NULL OR cooldown_until <= ?)
       ORDER BY next_run_at ASC LIMIT 100`,
    )
    .all(now, now) as unknown as LegacyRuleRow[];
}

function legacyCreatorRecipient(
  database: DatabaseSync,
  userId: string,
): LegacyRecipientRow | null {
  return (
    (database
      .prepare(
        `SELECT id, email, notification_preferences_json AS preferencesJson,
                preferred_locale AS preferredLocale, timezone AS timeZone
         FROM users WHERE id = ? LIMIT 1`,
      )
      .get(userId) as LegacyRecipientRow | undefined) ?? null
  );
}

function legacyUserRecipients(
  database: DatabaseSync,
  userIds: readonly string[],
): LegacyRecipientRow[] {
  if (userIds.length === 0) return [];
  return database
    .prepare(
      `SELECT id, email, notification_preferences_json AS preferencesJson,
              preferred_locale AS preferredLocale, timezone AS timeZone
       FROM users WHERE id IN (${userIds.map(() => "?").join(", ")})`,
    )
    .all(...userIds) as unknown as LegacyRecipientRow[];
}

function legacyTeamRecipients(
  database: DatabaseSync,
  teamId: string,
  mode: "team_admins" | "all_team_members",
): LegacyRecipientRow[] {
  const adminClause =
    mode === "team_admins"
      ? "AND (tm.role IN ('owner', 'admin') OR t.owner_user_id = u.id)"
      : "";
  return database
    .prepare(
      `SELECT DISTINCT u.id, u.email,
              u.notification_preferences_json AS preferencesJson,
              u.preferred_locale AS preferredLocale,
              u.timezone AS timeZone
       FROM users u
       INNER JOIN team_members tm ON tm.user_id = u.id
       INNER JOIN teams t ON t.id = tm.team_id
       WHERE tm.team_id = ? ${adminClause}
       ORDER BY u.created_at ASC`,
    )
    .all(teamId) as unknown as LegacyRecipientRow[];
}

function expectSameRule(
  actual: Awaited<ReturnType<typeof getNotificationRule>>,
  expected: LegacyRuleRow | null,
) {
  if (!expected) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).toMatchObject({
    id: expected.id,
    teamId: expected.teamId,
    siteId: expected.siteId,
    name: expected.name,
    description: expected.description ?? "",
    type: expected.type,
    enabled: expected.enabled === 1,
    state: JSON.parse(expected.stateJson),
    nextRunAt: expected.nextRunAt,
    cooldownUntil: expected.cooldownUntil,
    lastCheckedAt: expected.lastCheckedAt,
    lastTriggeredAt: expected.lastTriggeredAt,
    createdByUserId: expected.createdByUserId,
    createdAt: expected.createdAt,
    updatedAt: expected.updatedAt,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("notification rule Typed DAL differential checks", () => {
  it("matches legacy rule CRUD, listing, due selection, state, and schedule updates", async () => {
    const { database, env, trace } = createFixture();
    const actor = { user: { id: "owner-1" }, isAdmin: true } as never;
    const nowSeconds = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "created-rule" as ReturnType<Crypto["randomUUID"]>,
    );

    for (let index = 0; index < 105; index += 1) {
      insertLegacyRule(database, {
        id: `due-${index}`,
        nextRunAt: 500 + index,
        cooldownUntil: index % 3 === 0 ? 500 : null,
        updatedAt: 100 + index,
      });
    }
    insertLegacyRule(database, {
      id: "active-cooldown",
      nextRunAt: 1,
      cooldownUntil: 1_001,
      updatedAt: 300,
    });
    insertLegacyRule(database, {
      id: "test-rule",
      type: "test",
      nextRunAt: 1,
      updatedAt: 301,
    });
    insertLegacyRule(database, {
      id: "disabled-rule",
      enabled: 0,
      nextRunAt: 1,
      updatedAt: 302,
    });
    insertLegacyRule(database, {
      id: "future-rule",
      nextRunAt: 1_001,
      updatedAt: 303,
    });
    insertLegacyRule(database, {
      id: "managed-team-rule",
      teamId: "team-2",
      updatedAt: 304,
    });
    insertLegacyRule(database, {
      id: "member-only-team-rule",
      teamId: "team-3",
      updatedAt: 305,
    });
    insertLegacyRule(database, {
      id: "site-filter-rule",
      siteId: "site-1",
      updatedAt: 306,
    });

    const beforeCreate = trace.preparedSql.length;
    const created = await createNotificationRule(env, actor, {
      teamId: "team-1",
      name: " Created rule ",
      type: "threshold",
      schedule: { kind: "interval", everyMinutes: 60 },
    });
    expect(created.id).toBe("created-rule");
    expect(trace.preparedSql).toHaveLength(beforeCreate + 2);
    expectSameRule(created, legacyGet(database, "created-rule"));
    expectSameRule(
      await getNotificationRule(env, "created-rule"),
      legacyGet(database, "created-rule"),
    );

    const legacyAdminList = legacyList(database);
    const beforeList = trace.preparedSql.length;
    const typedAdminList = await listNotificationRules(env, actor);
    expect(trace.preparedSql).toHaveLength(beforeList + 1);
    expect(typedAdminList.map((rule) => rule.id)).toEqual(
      legacyAdminList.map((rule) => rule.id),
    );

    const typedTeamList = await listNotificationRules(env, actor, {
      teamId: "team-1",
    });
    expect(typedTeamList.map((rule) => rule.id)).toEqual(
      legacyList(database, "WHERE team_id = ?", ["team-1"]).map(
        (rule) => rule.id,
      ),
    );
    const typedSiteList = await listNotificationRules(env, actor, {
      siteId: "site-1",
    });
    expect(typedSiteList.map((rule) => rule.id)).toEqual(
      legacyList(database, "WHERE site_id = ?", ["site-1"]).map(
        (rule) => rule.id,
      ),
    );

    const legacyOwnerList = legacyList(
      database,
      `WHERE team_id IN (
         SELECT tm.team_id FROM team_members tm
         LEFT JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = ?
           AND (tm.role IN ('owner', 'admin') OR t.owner_user_id = ?)
       )`,
      ["owner-1", "owner-1"],
    );
    const ownerList = await listNotificationRules(env, {
      user: { id: "owner-1" },
      isAdmin: false,
    } as never);
    expect(ownerList.map((rule) => rule.id)).toEqual(
      legacyOwnerList.map((rule) => rule.id),
    );
    expect(ownerList.map((rule) => rule.teamId)).not.toContain("team-3");
    expect(ownerList.map((rule) => rule.teamId)).toContain("team-1");
    expect(ownerList.map((rule) => rule.teamId)).toContain("team-2");

    const legacyDueRows = legacyDue(database, 1_000);
    const beforeDue = trace.preparedSql.length;
    const typedDue = await listDueNotificationRules(env, 1_000);
    expect(trace.preparedSql).toHaveLength(beforeDue + 1);
    expect(typedDue.map((rule) => rule.id)).toEqual(
      legacyDueRows.map((rule) => rule.id),
    );
    expect(typedDue).toHaveLength(100);
    expect(typedDue[0]?.id).toBe("due-0");
    expect(typedDue.at(-1)?.id).toBe("due-99");

    const updateRow = {
      id: "rule-update",
      siteId: null,
      nextRunAt: 5_000,
      cooldownUntil: 8_000,
      stateJson: JSON.stringify({ old: true }),
    };
    insertLegacyRule(database, updateRow);
    const beforeUpdate = trace.preparedSql.length;
    const updated = await updateNotificationRule(env, actor, {
      ruleId: updateRow.id,
      name: "Updated rule",
    });
    expect(trace.preparedSql).toHaveLength(beforeUpdate + 3);
    expectSameRule(updated, legacyGet(database, updateRow.id));
    expect(updated.state).toEqual({ old: true });
    expect(updated.cooldownUntil).toBe(8_000);

    const beforeStateUpdate = trace.preparedSql.length;
    await updateNotificationRuleState(env, {
      ruleId: updateRow.id,
      state: { from: "state-update" },
      now: 2_000.9,
    });
    expect(trace.preparedSql).toHaveLength(beforeStateUpdate + 1);
    let persisted = legacyGet(database, updateRow.id);
    expect(persisted?.stateJson).toBe(JSON.stringify({ from: "state-update" }));
    expect(persisted?.updatedAt).toBe(2_000);

    const ruleForSchedule = await getNotificationRule(env, updateRow.id);
    if (!ruleForSchedule) throw new Error("missing_rule_for_schedule_test");
    const beforeAdvance = trace.preparedSql.length;
    await advanceNotificationRuleSchedule(env, {
      rule: ruleForSchedule,
      checkedAt: 2_000,
      triggeredAt: 1_999,
      state: { advanced: true },
    });
    expect(trace.preparedSql).toHaveLength(beforeAdvance + 1);
    persisted = legacyGet(database, updateRow.id);
    expect(persisted?.lastCheckedAt).toBe(2_000);
    expect(persisted?.lastTriggeredAt).toBe(1_999);
    expect(persisted?.nextRunAt).toBe(
      computeNextNotificationRunAt(
        { kind: "interval", everyMinutes: 60 },
        2_000,
      ),
    );
    expect(persisted?.cooldownUntil).toBe(8_000);
    expect(persisted?.stateJson).toBe(JSON.stringify({ advanced: true }));

    const expiredCooldownRule = await getNotificationRule(env, updateRow.id);
    if (!expiredCooldownRule) throw new Error("missing_expired_cooldown_rule");
    database
      .prepare("UPDATE notification_rules SET cooldown_until = ? WHERE id = ?")
      .run(1_999, updateRow.id);
    const beforeExpiredCooldown = trace.preparedSql.length;
    await advanceNotificationRuleSchedule(env, {
      rule: expiredCooldownRule,
      checkedAt: 2_000,
    });
    expect(trace.preparedSql).toHaveLength(beforeExpiredCooldown + 1);
    expect(legacyGet(database, updateRow.id)?.cooldownUntil).toBeNull();

    database
      .prepare("UPDATE notification_rules SET cooldown_until = ? WHERE id = ?")
      .run(9_000, updateRow.id);
    const futureCooldownRule = await getNotificationRule(env, updateRow.id);
    if (!futureCooldownRule) throw new Error("missing_future_cooldown_rule");
    const beforeFutureCooldown = trace.preparedSql.length;
    await advanceNotificationRuleSchedule(env, {
      rule: futureCooldownRule,
      checkedAt: 3_000,
    });
    expect(trace.preparedSql).toHaveLength(beforeFutureCooldown + 1);
    expect(legacyGet(database, updateRow.id)?.cooldownUntil).toBe(9_000);

    database
      .prepare(
        "UPDATE notification_rules SET cooldown_until = NULL WHERE id = ?",
      )
      .run(updateRow.id);
    const nullCooldownRule = await getNotificationRule(env, updateRow.id);
    if (!nullCooldownRule) throw new Error("missing_null_cooldown_rule");
    const beforeNullCooldown = trace.preparedSql.length;
    await advanceNotificationRuleSchedule(env, {
      rule: nullCooldownRule,
      checkedAt: 3_001,
    });
    expect(trace.preparedSql).toHaveLength(beforeNullCooldown + 1);
    expect(legacyGet(database, updateRow.id)?.cooldownUntil).toBeNull();

    database
      .prepare("UPDATE notification_rules SET next_run_at = ? WHERE id = ?")
      .run(8_000, updateRow.id);
    const manualFutureRule = await getNotificationRule(env, updateRow.id);
    if (!manualFutureRule) throw new Error("missing_manual_rule");
    const beforeManualFuture = trace.preparedSql.length;
    await applyNotificationRuleManualRunResult(env, {
      rule: { ...manualFutureRule, nextRunAt: 8_000 },
      checkedAt: 2_002,
      cooldownUntil: 9_000,
    });
    expect(trace.preparedSql).toHaveLength(beforeManualFuture + 1);
    persisted = legacyGet(database, updateRow.id);
    expect(persisted?.nextRunAt).toBe(8_000);
    expect(persisted?.cooldownUntil).toBe(9_000);

    database
      .prepare("UPDATE notification_rules SET next_run_at = ? WHERE id = ?")
      .run(1_999, updateRow.id);
    const manualDueRule = await getNotificationRule(env, updateRow.id);
    if (!manualDueRule) throw new Error("missing_manual_due_rule");
    const beforeManualDue = trace.preparedSql.length;
    await applyNotificationRuleManualRunResult(env, {
      rule: manualDueRule,
      checkedAt: 2_003,
    });
    expect(trace.preparedSql).toHaveLength(beforeManualDue + 1);
    expect(legacyGet(database, updateRow.id)?.nextRunAt).toBe(
      computeNextNotificationRunAt(
        { kind: "interval", everyMinutes: 60 },
        2_003,
      ),
    );

    const createdRule = await getNotificationRule(env, created.id);
    if (!createdRule) throw new Error("missing_created_rule_before_delete");
    const beforeDelete = trace.preparedSql.length;
    await expect(deleteNotificationRule(env, actor, created.id)).resolves.toBe(
      true,
    );
    expect(trace.preparedSql).toHaveLength(beforeDelete + 2);
    expect(legacyGet(database, created.id)).toBeNull();
  });

  it("matches legacy recipient resolution modes and chunks 200 explicit users", async () => {
    const { database, env, trace } = createFixture();
    const noCreatorRule = makeRecipientRule({ mode: "creator" });
    await expect(
      resolveNotificationRecipients(env, noCreatorRule),
    ).resolves.toEqual([]);
    expect(trace.preparedSql).toHaveLength(0);

    const creatorRule = makeRecipientRule(
      { mode: "creator" },
      { createdByUserId: "owner-1" },
    );
    await expect(
      resolveNotificationRecipients(env, creatorRule),
    ).resolves.toEqual([legacyCreatorRecipient(database, "owner-1")]);
    expect(trace.preparedSql).toHaveLength(1);

    const adminBefore = trace.preparedSql.length;
    const typedAdmins = await resolveNotificationRecipients(
      env,
      makeRecipientRule({ mode: "team_admins" }),
    );
    const legacyAdmins = legacyTeamRecipients(
      database,
      "team-1",
      "team_admins",
    );
    expect(typedAdmins).toEqual(legacyAdmins);
    expect(typedAdmins.map((recipient) => recipient.id)).toEqual([
      "owner-1",
      "admin-1",
      "role-owner",
    ]);
    // The Typed DAL compiler wraps each logical relation in an output alias.
    // Keep sorting as the terminal relation operation so no projection sits
    // outside the order clause.
    expect(trace.preparedSql[adminBefore]).toMatch(
      /ORDER BY .+ ASC\) AS "q\d+"$/,
    );
    expect(trace.preparedSql[adminBefore]).toContain("created_at");
    expect(trace.preparedSql).toHaveLength(adminBefore + 1);

    const membersBefore = trace.preparedSql.length;
    const typedMembers = await resolveNotificationRecipients(
      env,
      makeRecipientRule({ mode: "all_team_members" }),
    );
    const legacyMembers = legacyTeamRecipients(
      database,
      "team-1",
      "all_team_members",
    );
    expect(typedMembers).toEqual(legacyMembers);
    expect(typedMembers.map((recipient) => recipient.id)).toEqual([
      "owner-1",
      "member-1",
      "admin-1",
      "restricted-1",
      "role-owner",
    ]);
    expect(typedMembers.map((recipient) => recipient.id)).not.toContain(
      "unrelated-1",
    );
    expect(trace.preparedSql).toHaveLength(membersBefore + 1);

    const normalizedUsers = normalizeNotificationRecipientConfig({
      mode: "users",
      userIds: [" owner-1 ", "unrelated-1", "owner-1", "missing-user"],
    });
    expect(normalizedUsers).toEqual({
      mode: "users",
      userIds: ["owner-1", "unrelated-1", "missing-user"],
    });
    if (normalizedUsers.mode !== "users") {
      throw new Error("normalized_users_mode_expected");
    }
    const usersBefore = trace.preparedSql.length;
    const typedUsers = await resolveNotificationRecipients(
      env,
      makeRecipientRule(normalizedUsers),
    );
    const legacyUsers = legacyUserRecipients(database, normalizedUsers.userIds);
    expect(typedUsers.map((recipient) => recipient.id).sort()).toEqual(
      legacyUsers.map((recipient) => recipient.id).sort(),
    );
    expect(trace.preparedSql).toHaveLength(usersBefore + 1);

    const emptyUsersBefore = trace.preparedSql.length;
    await expect(
      resolveNotificationRecipients(
        env,
        makeRecipientRule({ mode: "users", userIds: [] }),
      ),
    ).resolves.toEqual([]);
    expect(trace.preparedSql).toHaveLength(emptyUsersBefore);

    const insertUser = database.prepare(
      "INSERT INTO users (id, email, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const requestedIds = Array.from({ length: 200 }, (_, index) => {
      const id = `chunk-user-${index}`;
      insertUser.run(
        id,
        `${id}@example.test`,
        id,
        1_000 + index,
        1_000 + index,
      );
      return id;
    });
    const cappedConfig = normalizeNotificationRecipientConfig({
      mode: "users",
      userIds: [...requestedIds, requestedIds[0], "not-included-after-cap"],
    });
    expect(cappedConfig).toEqual({ mode: "users", userIds: requestedIds });
    if (cappedConfig.mode !== "users") {
      throw new Error("normalized_chunk_users_mode_expected");
    }

    for (const count of [0, 1, 90, 91, 180, 200]) {
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const chunkIds = cappedConfig.userIds.slice(0, count);
      const chunked = await resolveNotificationRecipients(
        env,
        makeRecipientRule({ mode: "users", userIds: chunkIds }),
      );
      expect(chunked).toHaveLength(count);
      expect(trace.preparedSql).toHaveLength(Math.ceil(count / 90));
      expect(trace.bindings.map((bindings) => bindings.length)).toEqual(
        Array.from({ length: Math.ceil(count / 90) }, (_, index) =>
          Math.min(90, count - index * 90),
        ),
      );
      expect(trace.bindings.every((bindings) => bindings.length <= 100)).toBe(
        true,
      );
      if (count === 200) {
        expect(chunked.map((recipient) => recipient.id).sort()).toEqual(
          requestedIds.slice().sort(),
        );
        expect(trace.preparedSql).toHaveLength(3);
        expect(trace.preparedSql.join("\n")).not.toContain("json_each");
      }
    }
  });
});
