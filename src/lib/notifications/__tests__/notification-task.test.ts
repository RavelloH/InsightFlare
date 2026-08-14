import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setE2eClock } from "@/lib/edge/e2e-clock";
import type { ScheduledTaskContext } from "@/lib/edge/scheduled-task-runner";
import type { NotificationMessage } from "@/lib/notifications/message-store";
import {
  createManualTestNotification,
  createNotificationRulePreview,
  runNotificationRuleManually,
  runNotificationTick,
} from "@/lib/notifications/notification-task";
import type { NotificationRule } from "@/lib/notifications/rule-store";

const listDueNotificationRules = vi.hoisted(() => vi.fn());
const resolveNotificationRecipients = vi.hoisted(() => vi.fn());
const advanceNotificationRuleSchedule = vi.hoisted(() => vi.fn());
const applyNotificationRuleManualRunResult = vi.hoisted(() => vi.fn());
const evaluateNotificationRule = vi.hoisted(() => vi.fn());
const createNotificationMessage = vi.hoisted(() => vi.fn());
const deliverNotificationMessage = vi.hoisted(() => vi.fn());
const CLOCK_KEY = "__insightflare_e2e_clock__";

afterEach(() => {
  Reflect.deleteProperty(globalThis, CLOCK_KEY);
});

vi.mock("@/lib/notifications/rule-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listDueNotificationRules,
  resolveNotificationRecipients,
  advanceNotificationRuleSchedule,
  applyNotificationRuleManualRunResult,
}));

vi.mock("@/lib/notifications/evaluator", () => ({
  evaluateNotificationRule,
}));

vi.mock("@/lib/notifications/message-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNotificationMessage,
}));

vi.mock("@/lib/notifications/delivery", () => ({
  deliverNotificationMessage,
}));

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
    nextRunAt: 1,
    cooldownUntil: null,
    createdByUserId: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function message(
  input: Partial<NotificationMessage> = {},
): NotificationMessage {
  return {
    id: "msg-1",
    teamId: "team-1",
    siteId: "site-1",
    userId: "user-1",
    ruleId: "rule-1",
    runId: "run-1",
    batchId: "batch-1",
    type: "threshold",
    severity: "warning",
    requiresAttention: true,
    title: "Title",
    summary: "Summary",
    bodyText: "Body",
    bodyHtml: "",
    data: {},
    channels: {},
    deliveryStatus: "sent",
    deliveryResults: { email: { status: "sent" } },
    errorMessage: "",
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: 1,
    createdAt: 1,
    updatedAt: 1,
    sentAt: 1,
    failedAt: null,
    expiresAt: null,
    ...input,
  };
}

function context(): ScheduledTaskContext & {
  events: string[];
} {
  const events: string[] = [];
  const logger = {
    debug: vi.fn((event: string) => {
      events.push(event);
      return Promise.resolve();
    }),
    info: vi.fn((event: string) => {
      events.push(event);
      return Promise.resolve();
    }),
    warn: vi.fn((event: string) => {
      events.push(event);
      return Promise.resolve();
    }),
    error: vi.fn((event: string) => {
      events.push(event);
      return Promise.resolve();
    }),
  };
  return {
    env: {} as never,
    runId: "run-1",
    invocationId: "invocation-1",
    scheduledTime: null,
    startedAt: Date.now(),
    logger,
    externalFetch: fetch.bind(globalThis),
    events,
  };
}

describe("notification task", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    advanceNotificationRuleSchedule.mockResolvedValue(undefined);
    applyNotificationRuleManualRunResult.mockResolvedValue(undefined);
  });

  it("creates and delivers messages for triggered rules", async () => {
    listDueNotificationRules.mockResolvedValue([rule()]);
    evaluateNotificationRule.mockResolvedValue({
      status: "triggered",
      cooldownUntil: 2000,
      message: {
        type: "threshold",
        severity: "warning",
        requiresAttention: true,
        title: "Traffic threshold",
        summary: "Visitors reached the threshold",
        bodyText: "Body",
        data: { metric: "visitors" },
      },
      data: { metric: "visitors" },
    });
    resolveNotificationRecipients.mockResolvedValue([
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      },
    ]);
    createNotificationMessage.mockResolvedValue(message());
    deliverNotificationMessage.mockResolvedValue(message());

    const ctx = context();
    const outcome = await runNotificationTick(ctx);

    expect(outcome.status).toBe("success");
    expect(outcome.summary).toMatchObject({
      rulesScanned: 1,
      rulesChecked: 1,
      rulesTriggered: 1,
      messagesCreated: 1,
      emailSent: 1,
    });
    expect(createNotificationMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "threshold",
        severity: "warning",
        requiresAttention: true,
      }),
    );
    expect(advanceNotificationRuleSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        triggeredAt: expect.any(Number),
        cooldownUntil: 2000,
      }),
    );
    expect(ctx.events).toContain("notification_rule_checked");
    expect(ctx.events).toContain("notification_rule_triggered");
  });

  it("uses the controlled E2E clock for due rules and evaluations", async () => {
    setE2eClock(1_700_000_000_000);
    listDueNotificationRules.mockResolvedValue([]);

    await runNotificationTick(context());

    expect(listDueNotificationRules).toHaveBeenCalledWith(
      expect.anything(),
      1_700_000_000,
    );
  });

  it("advances checked rules without creating messages", async () => {
    listDueNotificationRules.mockResolvedValue([rule()]);
    evaluateNotificationRule.mockResolvedValue({
      status: "checked",
      triggered: false,
      summary: "Not over threshold",
      data: { value: 5 },
    });

    const outcome = await runNotificationTick(context());

    expect(outcome.summary).toMatchObject({
      rulesScanned: 1,
      rulesChecked: 1,
      rulesTriggered: 0,
      messagesCreated: 0,
    });
    expect(createNotificationMessage).not.toHaveBeenCalled();
    expect(advanceNotificationRuleSchedule).toHaveBeenCalled();
  });

  it("shares one invocation cache across every rule evaluated by a tick", async () => {
    listDueNotificationRules.mockResolvedValue([
      rule({ id: "rule-1" }),
      rule({ id: "rule-2" }),
    ]);
    evaluateNotificationRule.mockResolvedValue({
      status: "checked",
      triggered: false,
      summary: "Not triggered",
    });

    await runNotificationTick(context());

    expect(evaluateNotificationRule).toHaveBeenCalledTimes(2);
    const firstCache = evaluateNotificationRule.mock.calls[0]?.[3];
    const secondCache = evaluateNotificationRule.mock.calls[1]?.[3];
    expect(firstCache).toBe(secondCache);
    expect(firstCache).not.toBeUndefined();
  });

  it("continues when one rule evaluation fails", async () => {
    listDueNotificationRules.mockResolvedValue([rule({ id: "bad" }), rule()]);
    evaluateNotificationRule
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        status: "checked",
        triggered: false,
        summary: "Not triggered",
      });

    const ctx = context();
    const outcome = await runNotificationTick(ctx);

    expect(outcome.summary).toMatchObject({
      rulesScanned: 2,
      rulesChecked: 1,
      rulesSkipped: 1,
    });
    expect(ctx.events).toContain("notification_rule_failed");
    expect(advanceNotificationRuleSchedule).toHaveBeenCalledTimes(2);
  });

  it("previews a rule without creating messages or advancing schedule", async () => {
    evaluateNotificationRule.mockResolvedValue({
      status: "checked",
      triggered: false,
      summary: "Not triggered",
    });

    const result = await createNotificationRulePreview({} as never, rule());

    expect(result).toMatchObject({
      status: "checked",
      triggered: false,
    });
    expect(createNotificationMessage).not.toHaveBeenCalled();
    expect(deliverNotificationMessage).not.toHaveBeenCalled();
    expect(advanceNotificationRuleSchedule).not.toHaveBeenCalled();
  });

  it("manually runs a triggered rule and applies manual run state", async () => {
    evaluateNotificationRule.mockResolvedValue({
      status: "triggered",
      message: {
        type: "threshold",
        severity: "warning",
        requiresAttention: true,
        title: "Traffic threshold",
        summary: "Visitors reached the threshold",
        bodyText: "Body",
      },
    });
    resolveNotificationRecipients.mockResolvedValue([
      { id: "user-1", email: "user@example.test", preferencesJson: "{}" },
    ]);
    createNotificationMessage.mockResolvedValue(message());
    deliverNotificationMessage.mockResolvedValue(
      message({
        deliveryResults: {
          email: { status: "skipped", reason: "recipient_email_invalid" },
        },
      }),
    );

    const outcome = await runNotificationRuleManually({
      env: {} as never,
      context: context(),
      rule: rule(),
    });

    expect(outcome.messageCount).toBe(1);
    expect(outcome.summary).toMatchObject({
      rulesScanned: 1,
      rulesChecked: 1,
      rulesTriggered: 1,
      messagesCreated: 1,
      emailSkipped: 1,
      emailSkippedInvalidRecipient: 1,
    });
    expect(advanceNotificationRuleSchedule).not.toHaveBeenCalled();
    expect(applyNotificationRuleManualRunResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rule: expect.objectContaining({ id: "rule-1" }),
        triggeredAt: expect.any(Number),
      }),
    );
  });

  it("tracks skipped evaluation and missing recipients in manual runs", async () => {
    evaluateNotificationRule.mockResolvedValueOnce({
      status: "skipped",
      reason: "cooldown",
      data: { cooldownUntil: 2000 },
    });

    const skipped = await runNotificationRuleManually({
      env: {} as never,
      context: context(),
      rule: rule(),
    });

    expect(skipped).toMatchObject({
      messageCount: 0,
      summary: { rulesScanned: 1, rulesChecked: 1, rulesSkipped: 1 },
    });
    expect(applyNotificationRuleManualRunResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rule: expect.objectContaining({ id: "rule-1" }),
        checkedAt: expect.any(Number),
      }),
    );

    evaluateNotificationRule.mockResolvedValueOnce({
      status: "triggered",
      message: {
        type: "threshold",
        severity: "critical",
        requiresAttention: true,
        title: "Traffic threshold",
        summary: "Visitors reached the threshold",
        bodyText: "Body",
      },
    });
    resolveNotificationRecipients.mockResolvedValueOnce([]);

    const noRecipients = await runNotificationRuleManually({
      env: {} as never,
      context: context(),
      rule: rule({ recipient: { mode: "users", userIds: [] } }),
    });

    expect(noRecipients).toMatchObject({
      messageCount: 0,
      summary: {
        rulesScanned: 1,
        rulesChecked: 1,
        rulesTriggered: 1,
        rulesSkipped: 1,
      },
    });
    expect(createNotificationMessage).not.toHaveBeenCalled();
  });

  it("collects delivery stats across sent, failed, and system skipped email results", async () => {
    evaluateNotificationRule.mockResolvedValue({
      status: "triggered",
      message: {
        type: "threshold",
        severity: "warning",
        requiresAttention: true,
        title: "Traffic threshold",
        summary: "Visitors reached the threshold",
        bodyText: "Body",
      },
    });
    resolveNotificationRecipients.mockResolvedValue([
      { id: "sent", email: "sent@example.test", preferencesJson: "{}" },
      { id: "failed", email: "failed@example.test", preferencesJson: "{}" },
      { id: "system", email: "system@example.test", preferencesJson: "{}" },
      { id: "none", email: "none@example.test", preferencesJson: "{}" },
    ]);
    createNotificationMessage.mockImplementation((_env, input) =>
      Promise.resolve(
        message({ id: `msg-${input.userId}`, userId: input.userId }),
      ),
    );
    deliverNotificationMessage
      .mockResolvedValueOnce(
        message({
          deliveryResults: { email: { status: "sent" } },
        }),
      )
      .mockResolvedValueOnce(
        message({
          deliveryResults: { email: { status: "failed" } },
        }),
      )
      .mockResolvedValueOnce(
        message({
          deliveryResults: {
            email: { status: "skipped", reason: "system_email_unconfigured" },
          },
        }),
      )
      .mockResolvedValueOnce(message({ deliveryResults: {} }));

    const outcome = await runNotificationRuleManually({
      env: {} as never,
      context: context(),
      rule: rule(),
    });

    expect(outcome.summary).toMatchObject({
      messagesCreated: 4,
      inAppCreated: 4,
      emailAttempted: 2,
      emailSent: 1,
      emailFailed: 1,
      emailSkipped: 1,
      emailSkippedBySystem: 1,
    });
  });

  it("localizes triggered rule messages per recipient while sharing a batch", async () => {
    evaluateNotificationRule.mockResolvedValue({
      status: "triggered",
      message: {
        type: "report",
        severity: "info",
        requiresAttention: false,
        title: "Daily traffic report",
        summary: "Traffic report summary",
        bodyText: "Traffic report body",
        data: {
          siteDomain: "example.com",
          range: { label: "Yesterday" },
          metrics: { views: 1200, visitors: 450, sessions: 620 },
          topPages: [{ path: "/", views: 500 }],
          topReferrers: [{ source: "Direct", views: 300 }],
        },
      },
    });
    resolveNotificationRecipients.mockResolvedValue([
      {
        id: "user-en",
        email: "en@example.test",
        preferencesJson: "{}",
        preferredLocale: "en",
      },
      {
        id: "user-zh",
        email: "zh@example.test",
        preferencesJson: "{}",
        preferredLocale: "zh",
      },
    ]);
    createNotificationMessage.mockImplementation((_env, input) =>
      Promise.resolve(
        message({
          id: `msg-${input.userId}`,
          userId: input.userId,
          batchId: input.batchId,
          title: input.title,
          bodyText: input.bodyText,
          data: input.data,
        }),
      ),
    );
    deliverNotificationMessage.mockImplementation((_env, msg) =>
      Promise.resolve(msg),
    );

    await runNotificationRuleManually({
      env: {} as never,
      context: context(),
      rule: rule({ type: "report" }),
    });

    expect(createNotificationMessage).toHaveBeenCalledTimes(2);
    const [, enInput] = createNotificationMessage.mock.calls[0];
    const [, zhInput] = createNotificationMessage.mock.calls[1];
    expect(enInput.batchId).toBe(zhInput.batchId);
    expect(enInput.title).toContain("daily traffic report");
    expect(zhInput.title).toContain("每日访问报告");
    expect(enInput.bodyText).toContain("Core metrics");
    expect(zhInput.bodyText).toContain("核心指标");
    expect(enInput.data.locale).toBe("en");
    expect(zhInput.data.locale).toBe("zh");
  });

  it("creates manual test notifications and handles missing test recipients", async () => {
    type TestRecipientRow = {
      id: string;
      email: string;
      preferencesJson: string;
      preferredLocale?: string | null;
      timeZone?: string | null;
    };
    const first = vi.fn<() => Promise<TestRecipientRow | null>>(() =>
      Promise.resolve({
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      }),
    );
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first })),
        })),
      },
    };
    createNotificationMessage.mockResolvedValue(message({ type: "test" }));
    deliverNotificationMessage.mockResolvedValue(
      message({
        type: "test",
        deliveryResults: {
          email: { status: "skipped", reason: "secret_decryption_failed" },
        },
      }),
    );

    const created = await createManualTestNotification({
      env: env as never,
      context: context(),
      teamId: "team-1",
      siteId: null,
      userId: "user-1",
    });

    expect(created.summary).toMatchObject({
      messagesCreated: 1,
      inAppCreated: 1,
      emailSkipped: 1,
      emailSkippedBySystem: 1,
    });
    expect(createNotificationMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "test",
        severity: "info",
        requiresAttention: false,
        data: { source: "manual_test", locale: "en" },
      }),
    );

    first.mockResolvedValueOnce(null);
    const missing = await createManualTestNotification({
      env: env as never,
      context: context(),
      teamId: "team-1",
      userId: "missing",
    });

    expect(missing).toMatchObject({
      message: null,
      summary: { messagesCreated: 0 },
    });
  });

  it("localizes manual test notifications from recipient preference", async () => {
    type TestRecipientRow = {
      id: string;
      email: string;
      preferencesJson: string;
      preferredLocale?: string | null;
      timeZone?: string | null;
    };
    const first = vi
      .fn<() => Promise<TestRecipientRow | null>>()
      .mockResolvedValueOnce({
        id: "user-zh",
        email: "zh@example.test",
        preferencesJson: "{}",
        preferredLocale: "zh",
      })
      .mockResolvedValueOnce({
        id: "user-en",
        email: "en@example.test",
        preferencesJson: "{}",
        preferredLocale: "en",
      })
      .mockResolvedValueOnce({
        id: "user-default",
        email: "default@example.test",
        preferencesJson: "{}",
        preferredLocale: "",
      });
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first })),
        })),
      },
    };
    createNotificationMessage.mockImplementation((_env, input) =>
      Promise.resolve(
        message({
          id: `msg-${input.userId}`,
          userId: input.userId,
          type: "test",
          title: input.title,
          bodyText: input.bodyText,
          data: input.data,
        }),
      ),
    );
    deliverNotificationMessage.mockImplementation((_env, msg) =>
      Promise.resolve(msg),
    );

    await createManualTestNotification({
      env: env as never,
      context: context(),
      teamId: "team-1",
      userId: "user-zh",
    });
    await createManualTestNotification({
      env: env as never,
      context: context(),
      teamId: "team-1",
      userId: "user-en",
    });
    await createManualTestNotification({
      env: env as never,
      context: context(),
      teamId: "team-1",
      userId: "user-default",
    });

    const zhInput = createNotificationMessage.mock.calls[0][1];
    const enInput = createNotificationMessage.mock.calls[1][1];
    const defaultInput = createNotificationMessage.mock.calls[2][1];
    expect(zhInput.title).toContain("通知测试");
    expect(zhInput.data.locale).toBe("zh");
    expect(enInput.title).toContain("notification test");
    expect(enInput.data.locale).toBe("en");
    expect(defaultInput.title).toContain("notification test");
    expect(defaultInput.data.locale).toBe("en");
  });
});
