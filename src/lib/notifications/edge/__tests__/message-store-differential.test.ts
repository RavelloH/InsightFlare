import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import {
  countUnreadAttentionMessages,
  createNotificationMessage,
  getNotificationMessage,
  listNotificationMessagesForTeam,
  listNotificationMessagesForUser,
  mapNotificationMessage,
  markAllNotificationMessagesRead,
  markNotificationMessageRead,
  updateNotificationDeliveryResult,
} from "@/lib/notifications/edge/message-store";
import { safeJsonStringify } from "@/lib/notifications/json";
import {
  defaultRequiresAttention,
  normalizeNotificationDeliveryStatus,
  normalizeNotificationMessageType,
  normalizeNotificationSeverity,
} from "@/lib/notifications/message-types";
import { notificationRuleExpiresAtSeconds } from "@/lib/notifications/schedule";

const databases = new Set<DatabaseSync>();
const NOW = Math.trunc(Date.now() / 1000);

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };

  database
    .prepare("INSERT INTO users (id, email, username) VALUES (?, ?, ?)")
    .run("user-1", "user1@example.test", "user1");
  database
    .prepare("INSERT INTO users (id, email, username) VALUES (?, ?, ?)")
    .run("user-2", "user2@example.test", "user2");
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
  );
  insertTeam.run("team-1", "Team 1", "team-1", "user-1");
  insertTeam.run("team-2", "Team 2", "team-2", "user-2");
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain) VALUES (?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "Site 1", "site-1.example.test");
  insertSite.run("site-2", "team-2", "Site 2", "site-2.example.test");
  database
    .prepare(
      "INSERT INTO notification_rules (id, team_id, name, type) VALUES (?, ?, ?, ?)",
    )
    .run("rule-1", "team-1", "Rule 1", "report");

  const insertMessage = database.prepare(`
    INSERT INTO notification_messages (
      id, team_id, site_id, user_id, rule_id, type, severity,
      requires_attention, title, read_at, archived_at, created_at, updated_at,
      expires_at, sent_at, failed_at, channels_json, delivery_status,
      delivery_results_json, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = [
    [
      "msg-latest",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Latest",
      null,
      null,
      200,
      200,
      NOW + 500_000,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-tie-a",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Tie A",
      null,
      null,
      150,
      150,
      null,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-tie-b",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Tie B",
      null,
      null,
      150,
      150,
      NOW + 500_000,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-read",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Read",
      190,
      null,
      140,
      190,
      NOW + 500_000,
      180,
      null,
      '{"email":true}',
      "sent",
      "{}",
      null,
    ],
    [
      "msg-archived",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Archived",
      null,
      170,
      130,
      130,
      NOW + 500_000,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-expired",
      "team-1",
      "site-1",
      "user-1",
      "rule-1",
      "report",
      "warning",
      1,
      "Expired",
      null,
      null,
      120,
      120,
      1,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-other-user",
      "team-1",
      "site-1",
      "user-2",
      "rule-1",
      "report",
      "warning",
      1,
      "Other user",
      null,
      null,
      210,
      210,
      NOW + 500_000,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
    [
      "msg-other-team",
      "team-2",
      "site-2",
      "user-1",
      null,
      "threshold",
      "info",
      1,
      "Other team",
      null,
      null,
      160,
      160,
      NOW + 500_000,
      null,
      null,
      "{}",
      "created",
      "{}",
      null,
    ],
  ];
  for (const row of rows) insertMessage.run(...row);

  const insertMany = database.prepare(`
    INSERT INTO notification_messages (
      id, team_id, user_id, type, severity, requires_attention, title,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'system', 'info', 0, 'bulk', ?, ?, ?)
  `);
  for (let index = 0; index < 420; index += 1) {
    insertMany.run(
      `bulk-${index}`,
      "team-2",
      "user-2",
      index,
      index,
      NOW + 500_000,
    );
  }
  database.exec("ANALYZE");

  return {
    database,
    env: { DB: createSqliteD1Database(database, trace) } as unknown as Env,
    trace,
  };
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

function legacyList(
  database: DatabaseSync,
  ownerColumn: "user_id" | "team_id",
  ownerId: string,
  input: {
    userId?: string;
    teamId?: string;
    siteId?: string;
    ruleId?: string;
    type?: string;
    severity?: string;
    unread?: boolean;
    before?: number;
    limit?: number;
  },
) {
  const filters = [
    `${ownerColumn} = ?`,
    "archived_at IS NULL",
    "(expires_at IS NULL OR expires_at > ?)",
  ];
  const bindings: Array<string | number> = [ownerId, NOW];
  const optional =
    ownerColumn === "user_id"
      ? [
          ["team_id", input.teamId],
          ["site_id", input.siteId],
          ["rule_id", input.ruleId],
          ["type", input.type],
          ["severity", input.severity],
        ]
      : [
          ["user_id", input.userId],
          ["site_id", input.siteId],
          ["rule_id", input.ruleId],
          ["type", input.type],
          ["severity", input.severity],
        ];
  for (const [column, value] of optional) {
    if (value) {
      filters.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  if (input.unread) filters.push("read_at IS NULL");
  if (input.before) {
    filters.push("created_at < ?");
    bindings.push(Math.trunc(input.before));
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  bindings.push(limit);
  return database
    .prepare(
      `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE ${filters.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...bindings) as Array<Record<string, unknown>>;
}

function legacyRead(
  database: DatabaseSync,
  id: string,
  userId: string,
  now: number,
) {
  return database
    .prepare(
      `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    )
    .get(id, userId, now) as Record<string, unknown> | undefined;
}

function expectIndexSearch(plan: readonly string[], indexName: string) {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

function tracedStatement(trace: SqliteD1Trace, occurrenceFromEnd = 0) {
  const matches = trace.preparedSql
    .map((sql, index) => ({ sql, bindings: trace.bindings[index] ?? [] }))
    .filter(({ sql }) => sql.includes('"notification_messages"'));
  const result = matches[matches.length - 1 - occurrenceFromEnd];
  if (!result) throw new Error("missing_traced_notification_message_query");
  return result;
}

function resetTrace(trace: SqliteD1Trace) {
  trace.preparedSql.length = 0;
  trace.bindings.length = 0;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("notification message store Typed DAL differential", () => {
  it("preserves list filters, created-time ordering, and indexed access paths", async () => {
    const fixture = createFixture();
    const listInput = {
      userId: "user-1",
      teamId: "team-1",
      siteId: "site-1",
      ruleId: "rule-1",
      type: "report",
      severity: "warning",
      unread: true,
      before: 175,
      limit: 500,
    };
    const typedUserRows = await listNotificationMessagesForUser(
      fixture.env,
      listInput,
    );
    const legacyUserRows = legacyList(
      fixture.database,
      "user_id",
      listInput.userId,
      listInput,
    ).map((row) => mapNotificationMessage(row as never));
    expect(typedUserRows).toEqual(legacyUserRows);
    expect(typedUserRows.map((row) => row.id)).toHaveLength(2);
    const typedUserStatement = tracedStatement(fixture.trace);
    expect(typedUserStatement.sql.match(/ORDER BY/g)).toHaveLength(1);
    const legacyUserPlan = explainQueryPlan(fixture.database, {
      sql: `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE user_id=? AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND team_id=? AND site_id=? AND rule_id=? AND type=? AND severity=? AND read_at IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      bindings: [
        "user-1",
        NOW,
        "team-1",
        "site-1",
        "rule-1",
        "report",
        "warning",
        175,
        100,
      ],
    });
    const typedUserPlan = explainQueryPlan(
      fixture.database,
      typedUserStatement,
    );
    expectIndexSearch(typedUserPlan, "idx_notification_messages_site_created");
    expect(
      typedUserPlan.some((detail) =>
        detail.includes("idx_notification_messages_site_created"),
      ),
    ).toBe(
      legacyUserPlan.some((detail) =>
        detail.includes("idx_notification_messages_site_created"),
      ),
    );

    resetTrace(fixture.trace);
    const teamInput = {
      teamId: "team-1",
      userId: "user-1",
      unread: false,
      limit: 100,
    };
    const typedTeamRows = await listNotificationMessagesForTeam(
      fixture.env,
      teamInput,
    );
    const legacyTeamRows = legacyList(
      fixture.database,
      "team_id",
      teamInput.teamId,
      teamInput,
    ).map((row) => mapNotificationMessage(row as never));
    expect(typedTeamRows).toEqual(legacyTeamRows);
    const typedTeamPlan = explainQueryPlan(
      fixture.database,
      tracedStatement(fixture.trace),
    );
    expectIndexSearch(typedTeamPlan, "idx_notification_messages_team_created");
    const legacyTeamPlan = explainQueryPlan(fixture.database, {
      sql: `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE team_id=? AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND user_id=? ORDER BY created_at DESC LIMIT ?`,
      bindings: ["team-1", NOW, "user-1", 100],
    });
    expect(
      typedTeamPlan.some((detail) =>
        detail.includes("idx_notification_messages_team_created"),
      ),
    ).toBe(
      legacyTeamPlan.some((detail) =>
        detail.includes("idx_notification_messages_team_created"),
      ),
    );

    resetTrace(fixture.trace);
    const minimalUserInput = { userId: "user-1", limit: 50 };
    const typedMinimalUserRows = await listNotificationMessagesForUser(
      fixture.env,
      minimalUserInput,
    );
    const legacyMinimalUserRows = legacyList(
      fixture.database,
      "user_id",
      minimalUserInput.userId,
      minimalUserInput,
    ).map((row) => mapNotificationMessage(row as never));
    expect(typedMinimalUserRows).toEqual(legacyMinimalUserRows);
    const typedMinimalUserPlan = explainQueryPlan(
      fixture.database,
      tracedStatement(fixture.trace),
    );
    expectIndexSearch(
      typedMinimalUserPlan,
      "idx_notification_messages_user_created",
    );
  });

  it("matches unread counts and read updates, including team/global scope and expiry", async () => {
    const legacy = createFixture();
    const typed = createFixture();
    const legacyCount = legacy.database
      .prepare(
        `SELECT COUNT(*) AS count FROM notification_messages WHERE user_id=? AND requires_attention=1 AND read_at IS NULL AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get("user-1", NOW) as { count: number };
    await expect(
      countUnreadAttentionMessages(typed.env, "user-1"),
    ).resolves.toBe(Number(legacyCount.count));
    const countPlan = explainQueryPlan(
      typed.database,
      tracedStatement(typed.trace),
    );
    expectIndexSearch(countPlan, "idx_notification_messages_user_attention");

    const legacyReadAt = 300;
    legacy.database
      .prepare(
        `UPDATE notification_messages SET read_at=COALESCE(read_at, ?), updated_at=? WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(legacyReadAt, legacyReadAt, "msg-latest", "user-1", legacyReadAt);
    const typedRead = await markNotificationMessageRead(typed.env, {
      messageId: "msg-latest",
      userId: "user-1",
      now: legacyReadAt,
    });
    expect(typedRead).toEqual(
      mapNotificationMessage(
        legacyRead(
          legacy.database,
          "msg-latest",
          "user-1",
          legacyReadAt,
        ) as never,
      ),
    );
    expect(typed.trace.preparedSql).toHaveLength(3);
    const readPlan = explainQueryPlan(
      typed.database,
      tracedStatement(typed.trace),
    );
    expectIndexSearch(readPlan, "sqlite_autoindex_notification_messages_1");

    const legacyExpiredUpdatedAt = legacy.database
      .prepare("SELECT updated_at FROM notification_messages WHERE id=?")
      .get("msg-expired") as { updated_at: number };
    await expect(
      markNotificationMessageRead(typed.env, {
        messageId: "msg-expired",
        userId: "user-1",
        now: legacyReadAt,
      }),
    ).resolves.toBeNull();
    await expect(
      getNotificationMessage(typed.env, "msg-expired"),
    ).resolves.toBeNull();
    await expect(
      getNotificationMessage(typed.env, "msg-expired", {
        includeExpired: true,
      }),
    ).resolves.toMatchObject({ id: "msg-expired" });
    expect(
      typed.database
        .prepare("SELECT updated_at FROM notification_messages WHERE id=?")
        .get("msg-expired"),
    ).toEqual(legacyExpiredUpdatedAt);

    const legacyTeamResult = legacy.database
      .prepare(
        `UPDATE notification_messages SET read_at=COALESCE(read_at, ?), updated_at=? WHERE user_id=? AND team_id=? AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(400, 400, "user-1", "team-1", 400);
    await expect(
      markAllNotificationMessagesRead(typed.env, {
        userId: "user-1",
        teamId: "team-1",
        now: 400,
      }),
    ).resolves.toBe(Number(legacyTeamResult.changes));

    const legacyGlobalResult = legacy.database
      .prepare(
        `UPDATE notification_messages SET read_at=COALESCE(read_at, ?), updated_at=? WHERE user_id=? AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(500, 500, "user-1", 500);
    await expect(
      markAllNotificationMessagesRead(typed.env, {
        userId: "user-1",
        now: 500,
      }),
    ).resolves.toBe(Number(legacyGlobalResult.changes));
    const stateSql =
      "SELECT id, read_at, updated_at FROM notification_messages ORDER BY id";
    expect(typed.database.prepare(stateSql).all()).toEqual(
      legacy.database.prepare(stateSql).all(),
    );
  });

  it("keeps the mark-read reload scoped to the requested message owner", async () => {
    const legacy = createFixture();
    const typed = createFixture();
    const messageId = "msg-other-user";
    const wrongUserId = "user-1";
    const ownerUserId = "user-2";
    const wrongUserNow = NOW - 1_000;
    const ownerNow = NOW - 999;
    const stateSql =
      "SELECT read_at, updated_at FROM notification_messages WHERE id=?";
    const initialState = legacy.database.prepare(stateSql).get(messageId) as {
      read_at: number | null;
      updated_at: number;
    };

    legacy.database
      .prepare(
        `UPDATE notification_messages SET read_at=COALESCE(read_at, ?), updated_at=? WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(wrongUserNow, wrongUserNow, messageId, wrongUserId, wrongUserNow);
    const legacyWrongUserRow = legacyRead(
      legacy.database,
      messageId,
      wrongUserId,
      wrongUserNow,
    );
    const legacyWrongUserResult = legacyWrongUserRow
      ? mapNotificationMessage(legacyWrongUserRow as never)
      : null;
    const typedWrongUserResult = await markNotificationMessageRead(typed.env, {
      messageId,
      userId: wrongUserId,
      now: wrongUserNow,
    });

    expect(legacyWrongUserResult).toBeNull();
    expect(typedWrongUserResult).toEqual(legacyWrongUserResult);
    expect(typed.trace.preparedSql).toHaveLength(2);
    const wrongUserReload = tracedStatement(typed.trace);
    expect(wrongUserReload.bindings).toEqual(
      expect.arrayContaining([messageId, wrongUserId, wrongUserNow]),
    );
    expect(typed.database.prepare(stateSql).get(messageId)).toEqual(
      initialState,
    );
    expect(typed.database.prepare(stateSql).get(messageId)).toEqual(
      legacy.database.prepare(stateSql).get(messageId),
    );

    legacy.database
      .prepare(
        `UPDATE notification_messages SET read_at=COALESCE(read_at, ?), updated_at=? WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(ownerNow, ownerNow, messageId, ownerUserId, ownerNow);
    const legacyOwnerRow = legacyRead(
      legacy.database,
      messageId,
      ownerUserId,
      ownerNow,
    );
    const legacyOwnerResult = legacyOwnerRow
      ? mapNotificationMessage(legacyOwnerRow as never)
      : null;
    resetTrace(typed.trace);
    const typedOwnerResult = await markNotificationMessageRead(typed.env, {
      messageId,
      userId: ownerUserId,
      now: ownerNow,
    });

    expect(typedOwnerResult).toEqual(legacyOwnerResult);
    expect(typedOwnerResult).toMatchObject({
      id: messageId,
      userId: ownerUserId,
      readAt: ownerNow,
      updatedAt: ownerNow,
    });
    expect(typed.trace.preparedSql).toHaveLength(2);
    expect(typed.database.prepare(stateSql).get(messageId)).toEqual(
      legacy.database.prepare(stateSql).get(messageId),
    );
  });

  it("preserves delivery updates and two-query create/get behavior", async () => {
    const legacy = createFixture();
    const typed = createFixture();
    const updateBindings = [
      "failed",
      JSON.stringify({ email: { status: "failed" } }),
      null,
      "x".repeat(1000),
      600,
      "failed",
      600,
      "failed",
      600,
      "msg-latest",
    ];
    legacy.database
      .prepare(
        `UPDATE notification_messages SET delivery_status=?, delivery_results_json=?, channels_json=COALESCE(?, channels_json), error_message=?, updated_at=?, sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at, ?) ELSE sent_at END, failed_at=CASE WHEN ?='failed' THEN COALESCE(failed_at, ?) ELSE failed_at END WHERE id=?`,
      )
      .run(...updateBindings);
    const typedMessage = await updateNotificationDeliveryResult(typed.env, {
      messageId: "msg-latest",
      status: "failed",
      deliveryResults: { email: { status: "failed" } },
      errorMessage: "x".repeat(1200),
      now: 600,
    });
    expect(typedMessage).toEqual(
      mapNotificationMessage(
        legacyRead(legacy.database, "msg-latest", "user-1", NOW) as never,
      ),
    );
    expect(typed.trace.preparedSql).toHaveLength(2);

    resetTrace(typed.trace);
    legacy.database
      .prepare(
        `UPDATE notification_messages SET delivery_status=?, delivery_results_json=?, channels_json=COALESCE(?, channels_json), error_message=?, updated_at=?, sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at, ?) ELSE sent_at END, failed_at=CASE WHEN ?='failed' THEN COALESCE(failed_at, ?) ELSE failed_at END WHERE id=?`,
      )
      .run(
        "failed",
        JSON.stringify({ email: { status: "failed" } }),
        null,
        "expired update",
        601,
        "failed",
        601,
        "failed",
        601,
        "msg-expired",
      );
    await expect(
      updateNotificationDeliveryResult(typed.env, {
        messageId: "msg-expired",
        status: "failed",
        deliveryResults: { email: { status: "failed" } },
        errorMessage: "expired update",
        now: 601,
      }),
    ).resolves.toBeNull();
    expect(typed.trace.preparedSql).toHaveLength(2);
    const expiredDeliveryState =
      "SELECT delivery_status, delivery_results_json, error_message, updated_at, failed_at FROM notification_messages WHERE id=?";
    expect(
      typed.database.prepare(expiredDeliveryState).get("msg-expired"),
    ).toEqual(legacy.database.prepare(expiredDeliveryState).get("msg-expired"));

    const createLegacy = createFixture();
    const createTyped = createFixture();
    const id = "msg-differential-create";
    const input = {
      teamId: "team-1",
      siteId: "site-1",
      userId: "user-1",
      ruleId: "rule-1",
      type: "report" as const,
      severity: "warning" as const,
      title: "  Differential title  ",
      summary: "  Summary  ",
      bodyText: "  Body  ",
      data: { source: "test" },
      channels: { email: true },
      deliveryStatus: "sent" as const,
      triggeredAt: 699,
      now: 700,
    };
    const type = normalizeNotificationMessageType(input.type);
    const severity = normalizeNotificationSeverity(input.severity);
    const status = normalizeNotificationDeliveryStatus(input.deliveryStatus);
    const expiry = notificationRuleExpiresAtSeconds({
      type,
      severity,
      createdAtSeconds: input.now,
    });
    const attention = defaultRequiresAttention({ type, severity });
    const insertSql = `INSERT INTO notification_messages (id, team_id, site_id, user_id, rule_id, run_id, batch_id, type, severity, requires_attention, title, summary, body_text, body_html, data_json, channels_json, delivery_status, delivery_results_json, triggered_at, created_at, updated_at, sent_at, failed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    createLegacy.database
      .prepare(insertSql)
      .run(
        id,
        input.teamId,
        input.siteId,
        input.userId,
        input.ruleId,
        null,
        null,
        type,
        severity,
        attention ? 1 : 0,
        clampString(input.title.trim(), 240),
        clampString(input.summary.trim(), 500),
        clampString(input.bodyText.trim(), 4000),
        "",
        safeJsonStringify(input.data),
        safeJsonStringify(input.channels),
        status,
        "{}",
        input.triggeredAt,
        input.now,
        input.now,
        input.now,
        null,
        expiry,
      );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      id as ReturnType<Crypto["randomUUID"]>,
    );
    const created = await createNotificationMessage(createTyped.env, input);
    const legacyCreated = createLegacy.database
      .prepare(
        `SELECT ${MESSAGE_SELECT} FROM notification_messages WHERE id=? LIMIT 1`,
      )
      .get(id) as Record<string, unknown>;
    expect(created).toEqual(mapNotificationMessage(legacyCreated as never));
    expect(createTyped.trace.preparedSql).toHaveLength(2);
    expect(createTyped.trace.preparedSql[0]).toContain(
      'INSERT INTO "notification_messages"',
    );
    expect(createTyped.trace.preparedSql[1]).toContain(
      '"notification_messages"',
    );
  });
});
