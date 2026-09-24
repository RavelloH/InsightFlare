import { describe, expect, it, vi } from "vitest";

import type { NotificationRule } from "@/lib/notifications/edge/rule-store";
import {
  advanceNotificationRuleSchedule,
  applyNotificationRuleManualRunResult,
  createNotificationRule,
  deleteNotificationRule,
  listDueNotificationRules,
  listNotificationRules,
  mapNotificationRule,
  normalizeNotificationRecipientConfig,
  resolveNotificationRecipients,
  updateNotificationRule,
} from "@/lib/notifications/edge/rule-store";

function rule(input: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: "rule-1",
    teamId: "team-1",
    siteId: "site-1",
    name: "Rule",
    description: "",
    type: "threshold",
    enabled: true,
    schedule: { kind: "interval", everyMinutes: 60 },
    condition: {},
    recipient: { mode: "team_admins" },
    state: {},
    lastCheckedAt: null,
    lastTriggeredAt: null,
    nextRunAt: 100,
    cooldownUntil: null,
    createdByUserId: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

describe("notification rule store", () => {
  it("normalizes recipient configs and maps nullable rule rows", () => {
    expect(
      normalizeNotificationRecipientConfig({
        mode: "users",
        userIds: [" user-1 ", "user-1", "", 42, "x".repeat(200)],
      }),
    ).toEqual({
      mode: "users",
      userIds: ["user-1", "x".repeat(120)],
    });
    expect(
      normalizeNotificationRecipientConfig({ mode: "team_admins" }),
    ).toEqual({ mode: "team_admins" });
    expect(normalizeNotificationRecipientConfig("not-json")).toEqual({
      mode: "creator",
    });

    expect(
      mapNotificationRule({
        id: 1,
        teamId: 2,
        siteId: undefined,
        name: null,
        description: null,
        type: "unknown",
        enabled: 0,
        scheduleJson: "{",
        conditionJson: JSON.stringify({ metric: "visitors" }),
        recipientJson: JSON.stringify({ mode: "all_team_members" }),
        stateJson: JSON.stringify({
          milestone: { visitors: { lastBucket: 1000 } },
        }),
        lastCheckedAt: undefined,
        lastTriggeredAt: 3,
        nextRunAt: null,
        cooldownUntil: 4,
        createdByUserId: undefined,
        createdAt: undefined,
        updatedAt: 5,
      } as never),
    ).toMatchObject({
      id: "1",
      teamId: "2",
      siteId: null,
      name: "",
      type: "test",
      enabled: false,
      condition: { metric: "visitors" },
      recipient: { mode: "all_team_members" },
      state: { milestone: { visitors: { lastBucket: 1000 } } },
      lastCheckedAt: null,
      lastTriggeredAt: 3,
      nextRunAt: null,
      cooldownUntil: 4,
      createdByUserId: null,
      createdAt: 0,
      updatedAt: 5,
    });
  });

  it("creates rules with normalized defaults and creator attribution", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "rule-new" as ReturnType<Crypto["randomUUID"]>,
    );
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const inserted: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("INSERT INTO notification_rules")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                inserted.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() =>
                Promise.resolve({
                  id: "rule-new",
                  teamId: "team-1",
                  siteId: null,
                  name: "Notification rule",
                  description: "",
                  type: "test",
                  enabled: 1,
                  scheduleJson: JSON.stringify({
                    kind: "interval",
                    everyMinutes: 60,
                  }),
                  conditionJson: "{}",
                  recipientJson: JSON.stringify({ mode: "creator" }),
                  stateJson: "{}",
                  lastCheckedAt: null,
                  lastTriggeredAt: null,
                  nextRunAt: 1_800_003_600,
                  cooldownUntil: null,
                  createdByUserId: "user-1",
                  createdAt: 1_800_000_000,
                  updatedAt: 1_800_000_000,
                }),
              ),
            })),
          };
        }),
      },
    };

    const created = await createNotificationRule(
      env as never,
      { user: { id: "user-1" }, isAdmin: true } as never,
      { teamId: "team-1", name: "   ", schedule: "bad" },
    );

    expect(created.id).toBe("rule-new");
    expect(inserted[0]).toEqual([
      "rule-new",
      "team-1",
      null,
      "Notification rule",
      "",
      "test",
      1,
      JSON.stringify({ kind: "interval", everyMinutes: 60 }),
      "{}",
      JSON.stringify({ mode: "creator" }),
      "{}",
      1_800_003_600,
      "user-1",
      1_800_000_000,
      1_800_000_000,
    ]);
  });

  it("excludes test rules and active cooldowns from due rule queries", async () => {
    let sql = "";
    const env = {
      DB: {
        prepare: vi.fn((nextSql: string) => {
          sql = nextSql;
          return {
            bind: vi.fn(() => ({
              all: vi.fn(() => Promise.resolve({ results: [] })),
            })),
          };
        }),
      },
    };

    await listDueNotificationRules(env as never, 1000);

    expect(sql).toContain("AND type != 'test'");
    expect(sql).toContain("cooldown_until IS NULL OR cooldown_until <= ?");
  });

  it("writes cooldown when advancing a triggered rule", async () => {
    const bind = vi.fn(() => ({ run: vi.fn(() => Promise.resolve()) }));
    const env = {
      DB: {
        prepare: vi.fn(() => ({ bind })),
      },
    };

    await advanceNotificationRuleSchedule(env as never, {
      rule: rule(),
      checkedAt: 1000,
      triggeredAt: 1000,
      cooldownUntil: 2000,
    });

    expect(bind).toHaveBeenCalledWith(
      1000,
      1000,
      expect.any(Number),
      "{}",
      2000,
      2000,
      1000,
      1000,
      "rule-1",
    );
  });

  it("applies manual run state and advances only due next run", async () => {
    const bind = vi.fn(() => ({ run: vi.fn(() => Promise.resolve()) }));
    const env = {
      DB: {
        prepare: vi.fn(() => ({ bind })),
      },
    };

    await applyNotificationRuleManualRunResult(env as never, {
      rule: rule({ nextRunAt: 900 }),
      checkedAt: 1000,
      triggeredAt: 1000,
      cooldownUntil: 2000,
      state: { threshold: { lastTriggerKey: "key-1" } },
    });
    await applyNotificationRuleManualRunResult(env as never, {
      rule: rule({ id: "rule-future", nextRunAt: 3000 }),
      checkedAt: 1000,
    });

    expect(bind).toHaveBeenNthCalledWith(
      1,
      1000,
      1000,
      expect.any(Number),
      JSON.stringify({ threshold: { lastTriggerKey: "key-1" } }),
      2000,
      2000,
      1000,
      1000,
      "rule-1",
    );
    const calls = bind.mock.calls as unknown[][];
    expect(calls[0][2]).toBeGreaterThan(1000);
    expect(bind).toHaveBeenNthCalledWith(
      2,
      1000,
      null,
      3000,
      "{}",
      null,
      null,
      1000,
      1000,
      "rule-future",
    );
  });

  it("lists only manageable rules with actor-scoped filters for non-admins", async () => {
    const bind = vi.fn(() => ({
      all: vi.fn(() =>
        Promise.resolve({
          results: [
            {
              id: "rule-1",
              teamId: "team-1",
              siteId: null,
              name: "Rule",
              description: null,
              type: "report",
              enabled: 1,
              scheduleJson: "{}",
              conditionJson: "{}",
              recipientJson: "{}",
              stateJson: "{}",
              lastCheckedAt: null,
              lastTriggeredAt: null,
              nextRunAt: null,
              cooldownUntil: null,
              createdByUserId: null,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      ),
    }));
    const env = {
      DB: {
        prepare: vi.fn(() => ({ bind })),
      },
    };

    const rules = await listNotificationRules(
      env as never,
      { user: { id: "user-1" }, isAdmin: false } as never,
    );

    expect(rules).toHaveLength(1);
    expect(bind).toHaveBeenCalledWith("user-1", "user-1");
    const prepareCalls = env.DB.prepare.mock.calls as unknown as Array<
      [string]
    >;
    const sql = String(prepareCalls[0]?.[0] ?? "");
    expect(sql).toContain("LEFT JOIN teams t ON t.id = tm.team_id");
    expect(sql).toContain("tm.role IN ('owner', 'admin')");
    expect(sql).toContain("t.owner_user_id = ?");
  });

  it("requires manage permission when listing rules by team", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          preparedSql.push(sql);
          if (sql.includes("SELECT id,owner_user_id")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() =>
                  Promise.resolve({ id: "team-1", ownerUserId: "owner-1" }),
                ),
              })),
            };
          }
          if (sql.includes("SELECT role,site_ids_json")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() =>
                  Promise.resolve({ role: "member", siteIdsJson: "[]" }),
                ),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              all: vi.fn(() => Promise.resolve({ results: [] })),
            })),
          };
        }),
      },
    };

    await expect(
      listNotificationRules(
        env as never,
        { user: { id: "member-1" }, isAdmin: false } as never,
        { teamId: "team-1" },
      ),
    ).rejects.toThrow("Forbidden");
    expect(preparedSql.join("\n")).not.toContain("FROM notification_rules");
  });

  it("deletes manageable rules and returns false for missing rules", async () => {
    const run = vi.fn(() => Promise.resolve());
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("DELETE FROM notification_rules")) {
            return { bind: vi.fn(() => ({ run })) };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn((id: string) => ({
              first: vi.fn(() =>
                Promise.resolve(
                  id === "missing"
                    ? null
                    : {
                        id,
                        teamId: "team-1",
                        siteId: null,
                        name: "Rule",
                        description: "",
                        type: "report",
                        enabled: 1,
                        scheduleJson: "{}",
                        conditionJson: "{}",
                        recipientJson: "{}",
                        stateJson: "{}",
                        lastCheckedAt: null,
                        lastTriggeredAt: null,
                        nextRunAt: null,
                        cooldownUntil: null,
                        createdByUserId: null,
                        createdAt: 1,
                        updatedAt: 1,
                      },
                ),
              ),
            })),
          };
        }),
      },
    };
    const actor = { user: { id: "admin-1" }, isAdmin: true } as never;

    await expect(
      deleteNotificationRule(env as never, actor, "rule-1"),
    ).resolves.toBe(true);
    await expect(
      deleteNotificationRule(env as never, actor, "missing"),
    ).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resolves recipients for creator, explicit users, and team roles", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          preparedSql.push(sql);
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() =>
                Promise.resolve({
                  id: "creator",
                  email: "creator@example.test",
                  preferencesJson: "{}",
                }),
              ),
              all: vi.fn(() =>
                Promise.resolve({
                  results: [
                    {
                      id: "user-1",
                      email: "user@example.test",
                      preferencesJson: "{}",
                    },
                  ],
                }),
              ),
            })),
          };
        }),
      },
    };

    await expect(
      resolveNotificationRecipients(
        env as never,
        rule({ recipient: { mode: "creator" } }),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      resolveNotificationRecipients(
        env as never,
        rule({ recipient: { mode: "users", userIds: ["user-1", "user-2"] } }),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      resolveNotificationRecipients(
        env as never,
        rule({ recipient: { mode: "team_admins" } }),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      resolveNotificationRecipients(
        env as never,
        rule({ recipient: { mode: "creator" }, createdByUserId: null }),
      ),
    ).resolves.toEqual([]);

    expect(preparedSql.join("\n")).toContain("WHERE id IN (?, ?)");
    expect(preparedSql.join("\n")).toContain("tm.role IN ('owner', 'admin')");
  });

  it("preserves omitted fields when partially updating rule state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const currentRow = {
      id: "rule-1",
      teamId: "team-1",
      siteId: "site-1",
      name: "Daily report",
      description: "Original",
      type: "report",
      enabled: 1,
      scheduleJson: JSON.stringify({
        kind: "daily",
        time: "08:00",
        timezone: "UTC",
      }),
      conditionJson: JSON.stringify({ reportType: "daily" }),
      recipientJson: JSON.stringify({ mode: "team_admins" }),
      stateJson: "{}",
      lastCheckedAt: null,
      lastTriggeredAt: null,
      nextRunAt: 1_800_010_000,
      cooldownUntil: null,
      createdByUserId: "user-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const updateBind = vi.fn(() => ({
      run: vi.fn(() => Promise.resolve()),
    }));
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("UPDATE notification_rules")) {
            return { bind: updateBind };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() => Promise.resolve(currentRow)),
            })),
          };
        }),
      },
    };

    await updateNotificationRule(
      env as never,
      { user: { id: "admin-1" }, isAdmin: true } as never,
      { ruleId: "rule-1", enabled: false },
    );

    expect(updateBind).toHaveBeenCalledWith(
      "team-1",
      "site-1",
      "Daily report",
      "Original",
      "report",
      0,
      currentRow.scheduleJson,
      currentRow.conditionJson,
      currentRow.recipientJson,
      "{}",
      null,
      1_800_010_000,
      1_800_000_000,
      "rule-1",
    );
  });

  it("only recalculates schedule and recipient fields when those fields are provided", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const currentRow = {
      id: "rule-1",
      teamId: "team-1",
      siteId: "site-1",
      name: "Threshold",
      description: "",
      type: "threshold",
      enabled: 1,
      scheduleJson: JSON.stringify({ kind: "interval", everyMinutes: 60 }),
      conditionJson: JSON.stringify({ metric: "visitors" }),
      recipientJson: JSON.stringify({ mode: "team_admins" }),
      stateJson: "{}",
      lastCheckedAt: null,
      lastTriggeredAt: null,
      nextRunAt: 1_800_010_000,
      cooldownUntil: null,
      createdByUserId: "user-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("UPDATE notification_rules")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                calls.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() => Promise.resolve(currentRow)),
            })),
          };
        }),
      },
    };
    const actor = { user: { id: "admin-1" }, isAdmin: true } as never;

    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      name: "Renamed",
    });
    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      schedule: { kind: "interval", everyMinutes: 120 },
    });
    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      recipient: { mode: "creator" },
    });

    expect(calls[0][4]).toBe("threshold");
    expect(calls[0][6]).toBe(currentRow.scheduleJson);
    expect(calls[0][8]).toBe(currentRow.recipientJson);
    expect(calls[0][9]).toBe("{}");
    expect(calls[0][10]).toBeNull();
    expect(calls[0][11]).toBe(1_800_010_000);
    expect(calls[1][6]).toBe(
      JSON.stringify({ kind: "interval", everyMinutes: 120 }),
    );
    expect(calls[1][9]).toBe("{}");
    expect(calls[1][10]).toBeNull();
    expect(calls[1][11]).not.toBe(1_800_010_000);
    expect(calls[2][8]).toBe(JSON.stringify({ mode: "creator" }));
    expect(calls[2][6]).toBe(currentRow.scheduleJson);
  });

  it("resets state and cooldown when condition, type, or site changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const currentRow = {
      id: "rule-1",
      teamId: "team-1",
      siteId: "site-1",
      name: "Threshold",
      description: "",
      type: "threshold",
      enabled: 1,
      scheduleJson: JSON.stringify({ kind: "interval", everyMinutes: 60 }),
      conditionJson: JSON.stringify({ metric: "visitors", value: 10 }),
      recipientJson: JSON.stringify({ mode: "team_admins" }),
      stateJson: JSON.stringify({ threshold: { lastTriggerKey: "old" } }),
      lastCheckedAt: 10,
      lastTriggeredAt: 20,
      nextRunAt: 1_800_010_000,
      cooldownUntil: 1_800_020_000,
      createdByUserId: "user-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("UPDATE notification_rules")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                calls.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() => Promise.resolve(currentRow)),
            })),
          };
        }),
      },
    };
    const actor = { user: { id: "admin-1" }, isAdmin: true } as never;

    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      condition: { metric: "visitors", value: 20 },
    });
    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      type: "change",
    });
    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      siteId: "site-2",
    });

    for (const call of calls) {
      expect(call[9]).toBe("{}");
      expect(call[10]).toBeNull();
    }
  });

  it("preserves state and cooldown for metadata and schedule-only updates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const stateJson = JSON.stringify({
      threshold: { lastTriggerKey: "old" },
    });
    const currentRow = {
      id: "rule-1",
      teamId: "team-1",
      siteId: "site-1",
      name: "Threshold",
      description: "",
      type: "threshold",
      enabled: 1,
      scheduleJson: JSON.stringify({ kind: "interval", everyMinutes: 60 }),
      conditionJson: JSON.stringify({ metric: "visitors", value: 10 }),
      recipientJson: JSON.stringify({ mode: "team_admins" }),
      stateJson,
      lastCheckedAt: 10,
      lastTriggeredAt: 20,
      nextRunAt: 1_800_010_000,
      cooldownUntil: 1_800_020_000,
      createdByUserId: "user-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("UPDATE notification_rules")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                calls.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          if (sql.includes("SELECT team_id FROM sites")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn(() => Promise.resolve({ team_id: "team-1" })),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() => Promise.resolve(currentRow)),
            })),
          };
        }),
      },
    };
    const actor = { user: { id: "admin-1" }, isAdmin: true } as never;

    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      name: "Renamed",
      description: "Updated",
      enabled: false,
      recipient: { mode: "creator" },
    });
    await updateNotificationRule(env as never, actor, {
      ruleId: "rule-1",
      schedule: { kind: "interval", everyMinutes: 120 },
    });

    expect(calls[0][9]).toBe(stateJson);
    expect(calls[0][10]).toBe(1_800_020_000);
    expect(calls[0][11]).toBe(1_800_010_000);
    expect(calls[1][9]).toBe(stateJson);
    expect(calls[1][10]).toBe(1_800_020_000);
    expect(calls[1][11]).not.toBe(1_800_010_000);
  });
});
