import { describe, expect, it } from "vitest";

import {
  defaultNotificationEmailConfig,
  isValidEmail,
  makeSecretHint,
  normalizeNotificationEmailConfig,
  redactNotificationEmailConfig,
  validateNotificationEmailConfig,
  validateNotificationEmailUpdateInput,
} from "@/lib/notifications/email-config";

describe("notification email config", () => {
  it("normalizes missing config to defaults", () => {
    expect(normalizeNotificationEmailConfig(null)).toEqual(
      defaultNotificationEmailConfig(),
    );
  });

  it("redacts encrypted API key fields", () => {
    const redacted = redactNotificationEmailConfig(
      normalizeNotificationEmailConfig({
        enabled: true,
        provider: "resend",
        fromName: "InsightFlare",
        fromEmail: "noreply@example.test",
        resend: {
          apiKeyEncrypted: "v1:secret",
          apiKeyHint: "••••abcd",
          configured: true,
        },
      }),
    );

    expect(redacted.resend).toEqual({
      configured: true,
      apiKeyHint: "••••abcd",
    });
    expect(JSON.stringify(redacted)).not.toContain("apiKeyEncrypted");
    expect(JSON.stringify(redacted)).not.toContain("v1:secret");
  });

  it("normalizes partial and malformed config values", () => {
    expect(
      normalizeNotificationEmailConfig({
        enabled: "yes",
        provider: "none",
        fromName: "  ",
        fromEmail: 42,
        replyTo: " reply@example.test ",
        resend: {
          apiKeyEncrypted: " encrypted ",
          apiKeyHint: " hint ",
        },
        updatedAt: Number.NaN,
        updatedByUserId: 99,
      }),
    ).toMatchObject({
      enabled: false,
      provider: "none",
      fromName: "InsightFlare",
      fromEmail: "",
      replyTo: "reply@example.test",
      resend: {
        apiKeyEncrypted: "encrypted",
        apiKeyHint: "hint",
        configured: true,
      },
      updatedAt: 0,
      updatedByUserId: "",
    });

    expect(
      normalizeNotificationEmailConfig({
        provider: "other",
        resend: {
          apiKeyEncrypted: "encrypted",
          configured: false,
        },
        updatedAt: 123,
      }),
    ).toMatchObject({
      provider: "resend",
      resend: {
        apiKeyEncrypted: "encrypted",
        configured: false,
      },
      updatedAt: 123,
    });
  });

  it("validates update payload shape and email fields", () => {
    expect(
      validateNotificationEmailUpdateInput({
        enabled: "yes",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateNotificationEmailUpdateInput({
        fromEmail: "not-an-email",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateNotificationEmailUpdateInput({
        enabled: true,
        provider: "resend",
        fromEmail: "noreply@example.test",
        replyTo: "reply@example.test",
        resendApiKey: " re_demo ",
      }),
    ).toEqual({
      ok: true,
      input: {
        enabled: true,
        provider: "resend",
        fromEmail: "noreply@example.test",
        replyTo: "reply@example.test",
        resendApiKey: "re_demo",
      },
    });
  });

  it("rejects invalid update field variants", () => {
    const cases = [
      null,
      [],
      { provider: "smtp" },
      { fromName: "x".repeat(121) },
      { fromEmail: "x".repeat(255) },
      { replyTo: "not-an-email" },
      { replyTo: "x".repeat(255) },
      { resendApiKey: 123 },
      { resendApiKey: "x".repeat(513) },
      { clearResendApiKey: "yes" },
      { extra: "x".repeat(4100) },
    ];

    for (const payload of cases) {
      expect(validateNotificationEmailUpdateInput(payload)).toMatchObject({
        ok: false,
      });
    }

    expect(
      validateNotificationEmailUpdateInput({
        fromName: " ",
        fromEmail: "",
        replyTo: "",
        clearResendApiKey: false,
      }),
    ).toEqual({
      ok: true,
      input: {
        fromName: "InsightFlare",
        fromEmail: "",
        replyTo: "",
        clearResendApiKey: false,
      },
    });
  });

  it("requires a sender and API key when enabled", () => {
    const config = defaultNotificationEmailConfig();
    config.enabled = true;
    expect(validateNotificationEmailConfig(config)).toBe(
      "fromEmail is required when email sending is enabled",
    );

    config.fromEmail = "noreply@example.test";
    expect(validateNotificationEmailConfig(config)).toBe(
      "Resend API Key is required when Resend email sending is enabled",
    );
  });

  it("validates final config consistency", () => {
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        provider: "smtp" as never,
      }),
    ).toBe("Unsupported email provider");
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        fromName: "x".repeat(121),
      }),
    ).toBe("fromName is too long");
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        fromEmail: "bad",
      }),
    ).toBe("Invalid fromEmail");
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        replyTo: "bad",
      }),
    ).toBe("Invalid replyTo");
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        enabled: true,
        provider: "none",
      }),
    ).toBe("Resend provider is required when email sending is enabled");
    expect(
      validateNotificationEmailConfig({
        ...defaultNotificationEmailConfig(),
        enabled: true,
        fromEmail: "noreply@example.test",
        resend: {
          apiKeyEncrypted: "encrypted",
          apiKeyHint: "hint",
          configured: true,
        },
      }),
    ).toBeNull();
  });

  it("creates stable short secret hints", () => {
    expect(makeSecretHint(" re_123456abcd ")).toBe("••••abcd");
    expect(makeSecretHint("")).toBe("");
  });

  it("validates email syntax and length", () => {
    expect(isValidEmail("user@example.test")).toBe(true);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("user@example")).toBe(false);
    expect(isValidEmail(`${"a".repeat(245)}@example.test`)).toBe(false);
  });
});
