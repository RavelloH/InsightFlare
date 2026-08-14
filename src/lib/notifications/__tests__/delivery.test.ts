import { beforeEach, describe, expect, it, vi } from "vitest";

import { deliverNotificationMessage } from "@/lib/notifications/delivery";
import type { NotificationMessage } from "@/lib/notifications/message-store";
import { createNotificationInvocationCache } from "@/lib/notifications/notification-cache";

const updateNotificationDeliveryResult = vi.hoisted(() => vi.fn());
const readConfig = vi.hoisted(() => vi.fn());
const decryptNotificationSecret = vi.hoisted(() => vi.fn());
const renderNotificationEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notifications/message-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateNotificationDeliveryResult,
}));

vi.mock("@/lib/edge/system-config", () => ({
  readConfig,
}));

vi.mock("@/lib/edge/secret-encryption", () => ({
  decryptNotificationSecret,
}));

vi.mock("@/lib/notifications/email-renderer", () => ({
  renderNotificationEmail,
}));

function message(
  input: Partial<NotificationMessage> = {},
): NotificationMessage {
  return {
    id: "msg-1",
    teamId: "team-1",
    siteId: null,
    userId: "user-1",
    ruleId: null,
    runId: "run-1",
    batchId: null,
    type: "test",
    severity: "info",
    requiresAttention: false,
    title: "Test",
    summary: "Summary",
    bodyText: "Body",
    bodyHtml: "",
    data: {},
    channels: {},
    deliveryStatus: "created",
    deliveryResults: {},
    errorMessage: "",
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: null,
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
    failedAt: null,
    expiresAt: null,
    ...input,
  };
}

describe("notification delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateNotificationDeliveryResult.mockResolvedValue(message());
    renderNotificationEmail.mockResolvedValue({
      subject: "Rendered subject",
      text: "Rendered text",
      html: "<p>Rendered</p>",
    });
  });

  it("marks delivery sent when user disables email", async () => {
    await deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: JSON.stringify({ email: false }),
      },
      {},
    );

    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "msg-1",
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: {
            status: "skipped",
            reason: "user_preference_disabled",
          },
        }),
      }),
    );
  });

  it("marks delivery sent when system email is unconfigured", async () => {
    readConfig.mockResolvedValue(null);

    await deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      },
      {},
    );

    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: {
            status: "skipped",
            reason: "system_email_unconfigured",
          },
        }),
      }),
    );
  });

  it("reads the system email config once per notification invocation", async () => {
    readConfig.mockResolvedValue(null);
    const cache = createNotificationInvocationCache();

    await deliverNotificationMessage(
      {} as never,
      message({ id: "msg-1" }),
      { id: "user-1", email: "first@example.test", preferencesJson: "{}" },
      { cache },
    );
    await deliverNotificationMessage(
      {} as never,
      message({ id: "msg-2" }),
      { id: "user-2", email: "second@example.test", preferencesJson: "{}" },
      { cache },
    );

    expect(readConfig).toHaveBeenCalledTimes(1);
  });

  it("marks delivery failed when Resend rejects the request", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "InsightFlare",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid_from" }), {
        status: 400,
      }),
    );

    await deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      },
      {},
    );

    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        errorMessage: "invalid_from",
      }),
    );
  });

  it("sanitizes alternate provider error payloads", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "InsightFlare",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad_template" }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "ValidationError" }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(new Response("0", { status: 400 }));

    for (const email of [
      "user@example.test",
      "other@example.test",
      "third@example.test",
    ]) {
      await deliverNotificationMessage(
        {} as never,
        message(),
        { id: "user-1", email, preferencesJson: "{}" },
        {},
      );
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(updateNotificationDeliveryResult).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ errorMessage: "bad_template" }),
    );
    expect(updateNotificationDeliveryResult).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ errorMessage: "ValidationError" }),
    );
    expect(updateNotificationDeliveryResult).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({ errorMessage: "provider_error" }),
    );
  });

  it("handles blank provider error messages", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "InsightFlare",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "" }), {
        status: 400,
      }),
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      },
      { logger },
    );

    expect(logger.error).toHaveBeenCalledWith(
      "notification_delivery_failed",
      expect.any(String),
      expect.objectContaining({ errorMessage: "provider_error" }),
    );
    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorMessage: "provider_error" }),
    );
  });

  it("skips invalid recipients and undecryptable secrets", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "InsightFlare",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });

    await deliverNotificationMessage(
      {} as never,
      message(),
      { id: "user-1", email: "not-an-email", preferencesJson: "{}" },
      {},
    );
    expect(updateNotificationDeliveryResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: {
            status: "skipped",
            reason: "recipient_email_invalid",
          },
        }),
      }),
    );

    decryptNotificationSecret.mockRejectedValueOnce(new Error("bad secret"));
    await deliverNotificationMessage(
      {} as never,
      message(),
      { id: "user-1", email: "user@example.test", preferencesJson: "{}" },
      {},
    );
    expect(updateNotificationDeliveryResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: {
            status: "skipped",
            reason: "secret_decryption_failed",
          },
        }),
      }),
    );
  });

  it("marks delivery sent when Resend accepts the request", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: 'Insight "Flare"',
      replyTo: "reply@example.test",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-message-1" }), {
        status: 200,
      }),
    );

    await deliverNotificationMessage(
      {} as never,
      message(),
      { id: "user-1", email: "user@example.test", preferencesJson: "{}" },
      {},
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Insight Flare <from@example.test>"),
      }),
    );
    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: expect.objectContaining({
            status: "sent",
            provider: "resend",
            messageId: "provider-message-1",
          }),
        }),
      }),
    );
  });

  it("uses message locale before user locale when rendering email", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-message-1" }), {
        status: 200,
      }),
    );

    await deliverNotificationMessage(
      {} as never,
      message({ data: { locale: "zh" } }),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
        preferredLocale: "en",
      },
      {},
    );

    expect(renderNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh" }),
    );
  });

  it("falls back to user locale when message locale is missing", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-message-1" }), {
        status: 200,
      }),
    );

    await deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
        preferredLocale: "zh",
      },
      {},
    );

    expect(renderNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh" }),
    );
  });

  it("falls back to plain content when rendering fails", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    renderNotificationEmail.mockRejectedValueOnce(new Error("render failed"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: 123 }), {
        status: 200,
      }),
    );
    const baseMessage = message();
    const fallbackMessage = {
      ...baseMessage,
      bodyText: "",
      summary: "",
      bodyHtml: "<p>Fallback HTML</p>",
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await deliverNotificationMessage(
      {} as never,
      fallbackMessage,
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
        preferredLocale: "not-a-locale",
      },
      { logger },
    );

    const body = JSON.parse(
      String(
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      ),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "InsightFlare <from@example.test>",
      subject: "Test",
      text: "You have a new InsightFlare notification.",
      html: "<p>Fallback HTML</p>",
    });
    expect(body.reply_to).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "notification_email_render_failed",
      expect.any(String),
      expect.objectContaining({ error: "render failed" }),
    );
    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "sent",
        deliveryResults: expect.objectContaining({
          email: expect.objectContaining({ messageId: "" }),
        }),
      }),
    );
  });

  it("uses saved message text when localized rendering fails", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    renderNotificationEmail.mockRejectedValueOnce(new Error("render failed"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "provider-message-1" }), {
        status: 200,
      }),
    );

    await deliverNotificationMessage(
      {} as never,
      message({ title: "中文标题", bodyText: "中文正文" }),
      { id: "user-1", email: "user@example.test", preferencesJson: "{}" },
      {},
    );

    const body = JSON.parse(
      String(
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      ),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      subject: "中文标题",
      text: "中文正文",
    });
  });

  it("marks delivery failed when the provider cannot be reached", async () => {
    readConfig.mockResolvedValue({
      enabled: true,
      provider: "resend",
      fromEmail: "from@example.test",
      fromName: "",
      replyTo: "",
      resend: {
        configured: true,
        apiKeyEncrypted: "encrypted",
      },
    });
    decryptNotificationSecret.mockResolvedValue("re_secret");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));

    vi.useFakeTimers();
    const delivery = deliverNotificationMessage(
      {} as never,
      message(),
      {
        id: "user-1",
        email: "user@example.test",
        preferencesJson: "{}",
      },
      {},
    );
    await vi.runAllTimersAsync();
    await delivery;
    vi.useRealTimers();

    expect(updateNotificationDeliveryResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining(
          "Unable to reach Resend email API",
        ),
      }),
    );
    expect(
      updateNotificationDeliveryResult.mock.calls[0]?.[1].errorMessage,
    ).toContain("TypeError: offline");
  });
});
