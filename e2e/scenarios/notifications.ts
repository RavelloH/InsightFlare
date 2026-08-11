import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import type {
  E2eContext,
  NotificationEmailConfig,
  NotificationEvaluation,
  NotificationManualRun,
  NotificationMessage,
  NotificationRule,
} from "../support/flow-context";

export function registerNotificationScenarios(context: E2eContext) {
  const {
    adminPassword,
    advanceE2eClock,
    e2eControlRequest,
    readMockMailbox,
    saveManifest,
    seed,
  } = context;
  const { ownerA: ownerAPassword } = context.passwords;

  test("16. scheduled notifications create one persistent message per due rule", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const created = await apiRequest<{ id: string }>(
      page,
      "POST",
      "/api/private/admin/notification-rules",
      {
        condition: {
          metric: "views",
          operator: ">=",
          value: 0,
          window: "last_1h",
        },
        name: "E2E due threshold",
        recipient: { mode: "creator" },
        schedule: { everyMinutes: 30, kind: "interval" },
        siteId: siteA?.id,
        teamId: teamA?.id,
        type: "threshold",
      },
    );
    expect(created.status).toBe(200);
    const ruleId = created.payload.data?.id || "";
    expect(ruleId).not.toBe("");
    seed.notifications.threshold = {
      enabled: true,
      id: ruleId,
      lastCheckedAt: null,
    };
    await saveManifest();
    await advanceE2eClock(page, 30 * 60_000);
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run", {
      key: "notification_tick",
    });
    expect(scheduled.status).toBe(200);
    const messages = await apiRequest<{ messages: Array<{ ruleId: string }> }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(ruleId)}`,
    );
    expect(messages.payload.data?.messages).toHaveLength(1);
    expect(messages.payload.data?.messages[0]?.ruleId).toBe(ruleId);
    await e2eControlRequest(page, "POST", "scheduled/run", {
      key: "notification_tick",
    });
    const repeated = await apiRequest<{ messages: Array<{ ruleId: string }> }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(ruleId)}`,
    );
    expect(repeated.payload.data?.messages).toHaveLength(1);
  });

  test("17. notification recipients can mark alerts read and disabled rules stay dormant", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const rule = seed.notifications.threshold;
    expect(teamA).toBeDefined();
    expect(rule).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const beforeRead = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}`,
    );
    expect(beforeRead.status).toBe(200);
    const message = beforeRead.payload.data?.messages[0];
    expect(message).toMatchObject({ readAt: null, ruleId: rule?.id });

    const markedRead = await apiRequest<NotificationMessage>(
      page,
      "PATCH",
      `/api/private/notifications/${encodeURIComponent(message?.id || "")}`,
      {},
    );
    expect(markedRead.status).toBe(200);
    expect(markedRead.payload.data?.readAt).toEqual(expect.any(Number));
    const unread = await apiRequest<{ messages: NotificationMessage[] }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}&unread=1`,
    );
    expect(unread.status).toBe(200);
    expect(unread.payload.data?.messages).toEqual([]);

    const disabled = await apiRequest<NotificationRule>(
      page,
      "PATCH",
      "/api/private/admin/notification-rules",
      { enabled: false, ruleId: rule?.id },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.payload.data?.enabled).toBe(false);
    const lastCheckedAt = disabled.payload.data?.lastCheckedAt;
    await advanceE2eClock(page, 30 * 60_000);
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run", {
      key: "notification_tick",
    });
    expect(scheduled.status).toBe(200);

    const rules = await apiRequest<NotificationRule[]>(
      page,
      "GET",
      `/api/private/admin/notification-rules?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    const persistedRule = rules.payload.data?.find(
      (item) => item.id === rule?.id,
    );
    expect(persistedRule).toMatchObject({
      enabled: false,
      lastCheckedAt,
    });
    const messages = await apiRequest<{ messages: NotificationMessage[] }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}`,
    );
    expect(messages.payload.data?.messages).toHaveLength(1);
  });

  test("18. daily report previews, scheduled runs, and manual runs use historical truth", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const siteB = seed.sites.siteB;
    expect(teamA).toBeDefined();
    expect(siteB).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const created = await apiRequest<NotificationRule>(
      page,
      "POST",
      "/api/private/admin/notification-rules",
      {
        condition: { reportType: "daily" },
        name: "E2E daily report",
        recipient: { mode: "creator" },
        schedule: { kind: "daily", time: "14:00", timezone: "UTC" },
        siteId: siteB?.id,
        teamId: teamA?.id,
        type: "report",
      },
    );
    expect(created.status).toBe(200);
    const rule = created.payload.data;
    expect(rule?.id).toEqual(expect.any(String));
    if (!rule) throw new Error("Daily report rule was not created");
    seed.notifications.dailyReport = rule;
    await saveManifest();

    const preview = await apiRequest<NotificationEvaluation>(
      page,
      "POST",
      "/api/private/admin/notification-rules/preview",
      { ruleId: rule.id },
    );
    expect(preview.status).toBe(200);
    expect(preview.payload.data).toMatchObject({
      data: { metrics: { sessions: 1, views: 1, visitors: 1 } },
      status: "triggered",
    });

    await advanceE2eClock(page, 60 * 60_000);
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run", {
      key: "notification_tick",
    });
    expect(scheduled.status).toBe(200);
    const scheduledMessages = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule.id)}`,
    );
    expect(scheduledMessages.status).toBe(200);
    expect(scheduledMessages.payload.data?.messages).toHaveLength(1);

    const manual = await apiRequest<NotificationManualRun>(
      page,
      "POST",
      "/api/private/admin/notification-rules/run",
      { ruleId: rule.id },
    );
    expect(manual.status).toBe(200);
    expect(manual.payload.data).toMatchObject({
      evaluation: { status: "triggered" },
      messageCount: 1,
      summary: { messagesCreated: 1 },
    });
    const messagesAfterManualRun = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule.id)}`,
    );
    expect(messagesAfterManualRun.payload.data?.messages).toHaveLength(2);
  });

  test("19. local Resend mock receives configured test and in-app notification email", async ({
    page,
  }) => {
    const ownerA = seed.users.ownerA;
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(ownerA).toBeDefined();
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    await signIn(page, "admin", adminPassword);

    const configured = await apiRequest<NotificationEmailConfig>(
      page,
      "PATCH",
      "/api/private/admin/notification-email",
      {
        enabled: true,
        fromEmail: "notifications@e2e.test",
        fromName: "InsightFlare E2E",
        provider: "resend",
        replyTo: "replies@e2e.test",
        resendApiKey: "e2e-resend-api-key",
      },
    );
    expect(configured.status).toBe(200);
    expect(configured.payload.data).toMatchObject({
      enabled: true,
      fromEmail: "notifications@e2e.test",
      resend: { apiKeyHint: "••••-key", configured: true },
    });

    const testEmail = await apiRequest<{
      messageId: string;
      provider: string;
    }>(page, "POST", "/api/private/admin/notification-email/test", {
      to: ownerA?.email,
    });
    expect(testEmail.status).toBe(200);
    expect(testEmail.payload.data).toMatchObject({
      messageId: "e2e-email-1",
      provider: "resend",
    });

    const mailboxAfterTest = await readMockMailbox();
    expect(mailboxAfterTest).toEqual([
      expect.objectContaining({
        authorization: "Bearer e2e-resend-api-key",
        body: expect.objectContaining({
          from: "InsightFlare E2E <notifications@e2e.test>",
          subject: "InsightFlare email test",
          text: expect.stringContaining("Resend email configuration"),
          to: [ownerA?.email],
        }),
        id: "e2e-email-1",
      }),
    ]);

    const inAppTest = await apiRequest<{
      summary: { emailSent: number; messagesCreated: number };
    }>(page, "POST", "/api/private/admin/notification-test", {
      siteId: siteA?.id,
      teamId: teamA?.id,
      userId: ownerA?.id,
    });
    expect(inAppTest.status).toBe(200);
    expect(inAppTest.payload.data?.summary).toMatchObject({
      emailSent: 1,
      messagesCreated: 1,
    });
    const mailboxAfterNotification = await readMockMailbox();
    expect(mailboxAfterNotification).toHaveLength(2);
    expect(mailboxAfterNotification[1]).toMatchObject({
      body: expect.objectContaining({
        html: expect.stringContaining("InsightFlare notification test"),
        subject: "InsightFlare notification test",
        to: [ownerA?.email],
      }),
      id: "e2e-email-2",
    });
  });
}
