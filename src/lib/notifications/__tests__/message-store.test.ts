import { describe, expect, it, vi } from "vitest";

import {
  countUnreadAttentionMessages,
  createNotificationMessage,
  listNotificationMessagesForTeam,
  listNotificationMessagesForUser,
  mapNotificationMessage,
  markAllNotificationMessagesRead,
  markNotificationMessageRead,
  updateNotificationDeliveryResult,
} from "@/lib/notifications/message-store";

function row(input: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    teamId: "team-1",
    siteId: null,
    userId: "user-1",
    ruleId: null,
    runId: null,
    batchId: null,
    type: "threshold",
    severity: "warning",
    requiresAttention: 1,
    title: "Title",
    summary: null,
    bodyText: null,
    bodyHtml: null,
    dataJson: JSON.stringify({ metric: "visitors" }),
    channelsJson: JSON.stringify({ inApp: true }),
    deliveryStatus: "created",
    deliveryResultsJson: "{}",
    errorMessage: null,
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: 10,
    createdAt: 11,
    updatedAt: 12,
    sentAt: null,
    failedAt: null,
    expiresAt: 13,
    ...input,
  };
}

describe("notification message store", () => {
  it("maps rows with normalized types, statuses, json, and nullable fields", () => {
    expect(
      mapNotificationMessage(
        row({
          id: 1,
          teamId: 2,
          siteId: undefined,
          userId: 3,
          ruleId: 4,
          runId: 5,
          batchId: 6,
          type: "unknown",
          severity: "severe",
          requiresAttention: 0,
          title: null,
          dataJson: "{",
          channelsJson: { email: true },
          deliveryStatus: "lost",
          deliveryResultsJson: JSON.stringify({ email: "sent" }),
          errorMessage: null,
          readAt: undefined,
          dismissedAt: 7,
          archivedAt: 8,
          triggeredAt: undefined,
          createdAt: undefined,
          sentAt: 9,
          failedAt: undefined,
          expiresAt: null,
        }) as never,
      ),
    ).toMatchObject({
      id: "1",
      teamId: "2",
      siteId: null,
      userId: "3",
      ruleId: "4",
      runId: "5",
      batchId: "6",
      type: "system",
      severity: "info",
      requiresAttention: false,
      title: "",
      data: {},
      channels: { email: true },
      deliveryStatus: "created",
      deliveryResults: { email: "sent" },
      errorMessage: "",
      readAt: null,
      dismissedAt: 7,
      archivedAt: 8,
      triggeredAt: null,
      createdAt: 0,
      sentAt: 9,
      failedAt: null,
      expiresAt: null,
    });
  });

  it("creates messages with defaults, truncation, and sent timestamps", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "msg-new" as ReturnType<Crypto["randomUUID"]>,
    );
    const inserted: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("INSERT INTO notification_messages")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                inserted.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() =>
                Promise.resolve(
                  row({
                    id: "msg-new",
                    title: "T".repeat(240),
                    summary: "Summary",
                    bodyText: "Body",
                    deliveryStatus: "sent",
                    sentAt: 1000,
                    createdAt: 1000,
                    updatedAt: 1000,
                    triggeredAt: 999,
                  }),
                ),
              ),
            })),
          };
        }),
      },
    };

    const message = await createNotificationMessage(env as never, {
      teamId: "team-1",
      siteId: "site-1",
      userId: "user-1",
      type: "health",
      title: ` ${"T".repeat(300)} `,
      summary: " Summary ",
      bodyText: " Body ",
      deliveryStatus: "sent",
      triggeredAt: 999,
      now: 1000,
    });

    expect(message.id).toBe("msg-new");
    expect(inserted[0]).toEqual([
      "msg-new",
      "team-1",
      "site-1",
      "user-1",
      null,
      null,
      null,
      "health",
      "info",
      1,
      "T".repeat(240),
      "Summary",
      "Body",
      "",
      "{}",
      JSON.stringify({ inApp: true }),
      "sent",
      "{}",
      999,
      1000,
      1000,
      1000,
      null,
      expect.any(Number),
    ]);
  });

  it("creates failed messages with explicit optional fields and attention override", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "msg-failed" as ReturnType<Crypto["randomUUID"]>,
    );
    const inserted: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("INSERT INTO notification_messages")) {
            return {
              bind: vi.fn((...args: unknown[]) => {
                inserted.push(args);
                return { run: vi.fn(() => Promise.resolve()) };
              }),
            };
          }
          return {
            bind: vi.fn(() => ({
              first: vi.fn(() =>
                Promise.resolve(
                  row({
                    id: "msg-failed",
                    siteId: null,
                    ruleId: "rule-1",
                    runId: "run-1",
                    batchId: "batch-1",
                    type: "report",
                    severity: "critical",
                    requiresAttention: 0,
                    deliveryStatus: "failed",
                    failedAt: 2000,
                  }),
                ),
              ),
            })),
          };
        }),
      },
    };

    await expect(
      createNotificationMessage(env as never, {
        teamId: "team-1",
        userId: "user-1",
        ruleId: "rule-1",
        runId: "run-1",
        batchId: "batch-1",
        type: "report",
        severity: "critical",
        requiresAttention: false,
        title: "Report",
        data: { ok: true },
        channels: { email: true },
        deliveryStatus: "failed",
        deliveryResults: { email: { status: "failed" } },
        now: 2000,
      }),
    ).resolves.toMatchObject({
      id: "msg-failed",
      ruleId: "rule-1",
      runId: "run-1",
      batchId: "batch-1",
      deliveryStatus: "failed",
      failedAt: 2000,
    });

    expect(inserted[0]).toEqual([
      "msg-failed",
      "team-1",
      null,
      "user-1",
      "rule-1",
      "run-1",
      "batch-1",
      "report",
      "critical",
      0,
      "Report",
      "",
      "",
      "",
      JSON.stringify({ ok: true }),
      JSON.stringify({ email: true }),
      "failed",
      JSON.stringify({ email: { status: "failed" } }),
      2000,
      2000,
      2000,
      null,
      2000,
      expect.any(Number),
    ]);
  });

  it("builds user and team list filters with clamped limits and cursors", async () => {
    const calls: unknown[][] = [];
    const sqls: string[] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          sqls.push(sql);
          return {
            bind: vi.fn((...args: unknown[]) => {
              calls.push(args);
              return {
                all: vi.fn(() => Promise.resolve({ results: [row()] })),
              };
            }),
          };
        }),
      },
    };

    await listNotificationMessagesForUser(env as never, {
      userId: "user-1",
      teamId: "team-1",
      siteId: "site-1",
      type: "threshold",
      severity: "warning",
      unread: true,
      before: 12.8,
      limit: 500,
    });
    await listNotificationMessagesForTeam(env as never, {
      teamId: "team-1",
      userId: "user-1",
      unread: false,
      limit: 0,
    });

    expect(sqls[0]).toContain("user_id = ?");
    expect(sqls[0]).toContain("read_at IS NULL");
    expect(calls[0]?.[0]).toBe("user-1");
    expect(calls[0]?.slice(2)).toEqual([
      "team-1",
      "site-1",
      "threshold",
      "warning",
      12,
      100,
    ]);
    expect(typeof calls[0]?.[1]).toBe("number");
    expect(calls[1]?.[0]).toBe("team-1");
    expect(calls[1]?.slice(2)).toEqual(["user-1", 1]);
    expect(typeof calls[1]?.[1]).toBe("number");
  });

  it("builds minimal list filters without optional constraints", async () => {
    const calls: unknown[][] = [];
    const sqls: string[] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => {
          sqls.push(sql);
          return {
            bind: vi.fn((...args: unknown[]) => {
              calls.push(args);
              return { all: vi.fn(() => Promise.resolve({ results: [] })) };
            }),
          };
        }),
      },
    };

    await listNotificationMessagesForUser(env as never, {
      userId: "user-1",
      unread: false,
    });
    await listNotificationMessagesForTeam(env as never, {
      teamId: "team-1",
      unread: true,
      before: 0,
    });

    expect(sqls[0]).not.toContain("read_at IS NULL");
    expect(calls[0]?.[0]).toBe("user-1");
    expect(calls[0]?.slice(2)).toEqual([50]);
    expect(typeof calls[0]?.[1]).toBe("number");
    expect(sqls[1]).toContain("read_at IS NULL");
    expect(calls[1]?.[0]).toBe("team-1");
    expect(calls[1]?.slice(2)).toEqual([50]);
    expect(typeof calls[1]?.[1]).toBe("number");
  });

  it("counts and marks messages as read", async () => {
    const run = vi.fn(() => Promise.resolve({ meta: { changes: 3 } }));
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve(
                sql.includes("COUNT(*)") ? { count: 4 } : row({ readAt: 50 }),
              ),
            ),
            run,
          })),
        })),
      },
    };

    await expect(
      countUnreadAttentionMessages(env as never, "user-1"),
    ).resolves.toBe(4);
    await expect(
      markNotificationMessageRead(env as never, {
        messageId: "msg-1",
        userId: "user-1",
        now: 50,
      }),
    ).resolves.toMatchObject({ readAt: 50 });
    await expect(
      markAllNotificationMessagesRead(env as never, {
        userId: "user-1",
        teamId: "team-1",
        now: 60,
      }),
    ).resolves.toBe(3);
    await expect(
      markAllNotificationMessagesRead(env as never, {
        userId: "user-1",
        now: 70,
      }),
    ).resolves.toBe(3);
  });

  it("handles empty counts, missing reads, and read-all without team scope", async () => {
    const run = vi.fn(() => Promise.resolve({ meta: {} }));
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve(sql.includes("COUNT(*)") ? null : null),
            ),
            run,
          })),
        })),
      },
    };

    await expect(
      countUnreadAttentionMessages(env as never, "user-1"),
    ).resolves.toBe(0);
    await expect(
      markNotificationMessageRead(env as never, {
        messageId: "missing",
        userId: "user-1",
      }),
    ).resolves.toBeNull();
    await expect(
      markAllNotificationMessagesRead(env as never, { userId: "user-1" }),
    ).resolves.toBe(0);
  });

  it("updates delivery results with sent and failed timestamps", async () => {
    const binds: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: unknown[]) => {
            binds.push(args);
            return {
              run: vi.fn(() => Promise.resolve()),
              first: vi.fn(() =>
                Promise.resolve(
                  row({ deliveryStatus: "failed", failedAt: 70 }),
                ),
              ),
            };
          }),
        })),
      },
    };

    await expect(
      updateNotificationDeliveryResult(env as never, {
        messageId: "msg-1",
        status: "failed",
        deliveryResults: { email: { status: "failed" } },
        channels: { email: true },
        errorMessage: "x".repeat(1200),
        now: 70,
      }),
    ).resolves.toMatchObject({ deliveryStatus: "failed", failedAt: 70 });

    expect(binds[0]).toEqual([
      "failed",
      JSON.stringify({ email: { status: "failed" } }),
      JSON.stringify({ email: true }),
      "x".repeat(1000),
      70,
      "failed",
      70,
      "failed",
      70,
      "msg-1",
    ]);
  });

  it("updates delivery results without replacing channels and normalizes sent status", async () => {
    const binds: unknown[][] = [];
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn((...args: unknown[]) => {
            binds.push(args);
            return {
              run: vi.fn(() => Promise.resolve()),
              first: vi.fn(() =>
                Promise.resolve(row({ deliveryStatus: "sent", sentAt: 80 })),
              ),
            };
          }),
        })),
      },
    };

    await expect(
      updateNotificationDeliveryResult(env as never, {
        messageId: "msg-1",
        status: "sent",
        deliveryResults: {},
        now: 80,
      }),
    ).resolves.toMatchObject({ deliveryStatus: "sent", sentAt: 80 });

    expect(binds[0]).toEqual([
      "sent",
      "{}",
      null,
      "",
      80,
      "sent",
      80,
      "sent",
      80,
      "msg-1",
    ]);
  });
});
