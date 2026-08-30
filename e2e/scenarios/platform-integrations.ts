import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

export function registerPlatformIntegrationScenarios(context: E2eContext) {
  test("20. Resend 4xx failures are surfaced without a false delivery success", async ({
    page,
  }) => {
    await signIn(page, "admin", context.adminPassword);
    await context.setResendMockMode("bad_request");
    try {
      const failed = await apiRequest<unknown>(
        page,
        "POST",
        "/api/private/admin/notification-email/test",
        { to: "admin@example.test" },
      );
      expect(failed.status).toBe(400);
      const failure = JSON.stringify(failed.payload);
      expect(failure).toContain("Resend request failed");
      expect(failure).toContain("E2E forced Resend bad_request");
      expect(await context.readMockMailbox()).toHaveLength(2);
    } finally {
      await context.setResendMockMode("success");
    }
  });

  test("21. request observation reads normal and abnormal events from the local Cloudflare mock", async ({
    page,
  }) => {
    await signIn(page, "admin", context.adminPassword);
    const configured = await apiRequest<{
      accountId: string;
      apiTokenConfigured: boolean;
    }>(page, "PATCH", "/api/private/admin/bot-analytics-config", {
      accountId: "0123456789abcdef0123456789abcdef",
      apiToken: "e2e-cloudflare-token",
    });
    expect(configured.status).toBe(200);
    expect(configured.payload.data).toMatchObject({
      accountId: "0123456789abcdef0123456789abcdef",
      apiTokenConfigured: true,
    });

    const observed = await apiRequest<{
      configured: boolean;
      events: Array<{ category: string; rayId: string }>;
      normalEvents: Array<{ pathname: string; traceId: string }>;
      overview: {
        abnormalRequests: number;
        normalRequests: number;
        p95LatencyMs: number | null;
      };
    }>(
      page,
      "GET",
      `/api/private/admin/bot-analytics?from=${context.currentE2eNowMs() - 3_600_000}&to=${context.currentE2eNowMs()}&interval=hour&timeZone=Asia%2FShanghai&limit=10`,
    );
    expect(observed.status).toBe(200);
    expect(observed.payload).toMatchObject({
      configured: true,
      events: [{ category: "high_threat", rayId: "e2e-bot-ray" }],
      normalEvents: [{ pathname: "/home", traceId: "e2e-normal-trace" }],
      overview: {
        abnormalRequests: 2,
        normalRequests: 3,
        p95LatencyMs: 50,
      },
    });

    const rejectedConfig = await apiRequest<unknown>(
      page,
      "PATCH",
      "/api/private/admin/bot-analytics-config",
      { apiToken: "e2e-rejected-cloudflare-token" },
    );
    expect(rejectedConfig.status).toBe(200);
    try {
      const rejected = await apiRequest<unknown>(
        page,
        "GET",
        `/api/private/admin/bot-analytics?from=${context.currentE2eNowMs() - 3_600_000}&to=${context.currentE2eNowMs()}&interval=hour&timeZone=Asia%2FShanghai&limit=10`,
      );
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.payload)).toContain(
        "E2E Cloudflare token rejected",
      );
    } finally {
      const restored = await apiRequest<unknown>(
        page,
        "PATCH",
        "/api/private/admin/bot-analytics-config",
        { apiToken: "e2e-cloudflare-token" },
      );
      expect(restored.status).toBe(200);
    }

    await page.goto("/zh/app/manage/request-observation", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-geo-map-mode="3d"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test("22. administrator version updates render local release data in SSR and the client", async ({
    page,
  }) => {
    await signIn(page, "admin", context.adminPassword);
    const response = await page.request.get("/zh/app/manage/version-updates");
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("当前版本");
    expect(html).toContain("最新版本");
    expect(html).toContain("当前提交");
    expect(html).toContain("发布数");
    expect(html).toContain("更新说明");
    expect(html).toContain("查看详细变更");
    expect(html).toContain("E2E mock release notes");

    await page.goto("/zh/app/manage/version-updates", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("E2E mock release notes")).toBeVisible();
  });

  test("23. local Turnstile mock protects login and verifies administrator settings", async ({
    page,
  }) => {
    await signIn(page, "admin", context.adminPassword);
    const configured = await apiRequest<{
      enabled: boolean;
      secretKeyConfigured: boolean;
      siteKey: string;
    }>(page, "PATCH", "/api/private/admin/login-turnstile", {
      enabled: true,
      secretKey: "e2e-turnstile-secret",
      siteKey: "e2e-turnstile-site-key",
    });
    expect(configured.status).toBe(200);
    expect(configured.payload.data).toMatchObject({
      enabled: true,
      secretKeyConfigured: true,
      siteKey: "e2e-turnstile-site-key",
    });
    const verification = await apiRequest<{ verified: boolean }>(
      page,
      "POST",
      "/api/private/admin/login-turnstile/test",
      {
        secretKey: "e2e-turnstile-secret",
        siteKey: "e2e-turnstile-site-key",
        turnstileToken: "e2e-turnstile-pass",
      },
    );
    expect(verification.status).toBe(200);
    expect(verification.payload.data).toMatchObject({ verified: true });

    const login = async (turnstileToken?: string) =>
      page.evaluate(
        async ({ password, turnstileToken }) => {
          const response = await fetch("/api/public/session", {
            body: JSON.stringify({
              password,
              ...(turnstileToken ? { turnstileToken } : {}),
              username: "admin",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          return {
            payload: (await response.json()) as {
              error?: { code?: string };
              ok?: boolean;
            },
            status: response.status,
          };
        },
        { password: context.adminPassword, turnstileToken },
      );
    const missing = await login();
    expect(missing.status).toBe(400);
    expect(missing.payload.error?.code).toBe("turnstile_required");
    const invalid = await login("invalid-token");
    expect(invalid.status).toBe(400);
    expect(invalid.payload.error?.code).toBe("turnstile_failed");
    const verified = await login("e2e-turnstile-pass");
    expect(verified.status).toBe(200);
    expect(verified.payload.ok).toBe(true);
    const disabled = await apiRequest<{ enabled: boolean }>(
      page,
      "DELETE",
      "/api/private/admin/login-turnstile",
    );
    expect(disabled.status).toBe(200);
    expect(disabled.payload.data).toMatchObject({ enabled: false });
  });
}
