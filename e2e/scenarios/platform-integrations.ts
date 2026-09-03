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

  test("21. request observation reads blocked and included events from the local Cloudflare mock", async ({
    page,
  }) => {
    await signIn(page, "admin", context.adminPassword);
    await page.goto("/zh/app/manage/system-settings", {
      waitUntil: "networkidle",
    });
    const analyticsEngineAccountId = page.locator(
      "#analytics-engine-account-id",
    );
    const analyticsEngineApiToken = page.locator("#analytics-engine-api-token");
    await expect(analyticsEngineAccountId).toBeVisible();
    await analyticsEngineAccountId.fill("0123456789abcdef0123456789abcdef");
    await analyticsEngineApiToken.fill("e2e-cloudflare-token");
    await expect(analyticsEngineAccountId).toHaveValue(
      "0123456789abcdef0123456789abcdef",
    );
    const configuredResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/private/admin/analytics-engine-config") &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "保存配置", exact: true })
      .first()
      .click();
    const configured = await configuredResponse;
    expect(configured.status()).toBe(200);
    expect(await configured.json()).toMatchObject({
      ok: true,
      data: {
        accountId: "0123456789abcdef0123456789abcdef",
        apiTokenConfigured: true,
      },
    });

    const observed = await apiRequest<{
      configured: boolean;
      blockedEvents: Array<{
        category: string;
        disposition: string;
        rayId: string;
      }>;
      includedEvents: Array<{
        category: string;
        disposition: string;
        pathname: string;
        traceId: string;
      }>;
      overview: {
        totalRequests: number;
        includedRequests: number;
        blockedRequests: number;
        botRequests: number;
        normalRequests: number;
        blockedRequestRatio: number;
        botRequestRatio: number;
        p95LatencyMs: number | null;
      };
    }>(
      page,
      "GET",
      `/api/private/admin/request-observation?from=${context.currentE2eNowMs() - 3_600_000}&to=${context.currentE2eNowMs()}&interval=hour&timeZone=Asia%2FShanghai&limit=10`,
    );
    expect(observed.status).toBe(200);
    expect(observed.payload).toMatchObject({
      configured: true,
      blockedEvents: [
        {
          category: "bot",
          disposition: "blocked",
          rayId: "e2e-bot-ray",
        },
      ],
      includedEvents: [
        {
          category: "normal",
          disposition: "included",
          pathname: "/home",
          traceId: "e2e-normal-trace",
        },
      ],
      overview: {
        totalRequests: 5,
        includedRequests: 3,
        blockedRequests: 2,
        botRequests: 2,
        normalRequests: 3,
        blockedRequestRatio: 0.4,
        botRequestRatio: 0.4,
        p95LatencyMs: 50,
      },
    });

    const rejectedConfig = await apiRequest<unknown>(
      page,
      "PATCH",
      "/api/private/admin/analytics-engine-config",
      { apiToken: "e2e-rejected-cloudflare-token" },
    );
    expect(rejectedConfig.status).toBe(200);
    try {
      const rejected = await apiRequest<unknown>(
        page,
        "GET",
        `/api/private/admin/request-observation?from=${context.currentE2eNowMs() - 3_600_000}&to=${context.currentE2eNowMs()}&interval=hour&timeZone=Asia%2FShanghai&limit=10`,
      );
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.payload)).toContain(
        "E2E Cloudflare token rejected",
      );
    } finally {
      const restored = await apiRequest<unknown>(
        page,
        "PATCH",
        "/api/private/admin/analytics-engine-config",
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
    await expect(page.getByText("请求分流趋势", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "拦截请求", exact: true }).click();
    await expect(page).toHaveURL(/requestTab=blocked/);
    await expect(page.getByText("最近拦截请求", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "ASN 组织", exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "ASN 组织", exact: true })
      .first()
      .click();
    await expect(
      page.getByText("E2E Bot Network", { exact: true }).first(),
    ).toBeVisible();

    await page.locator('tr[role="button"]').first().click();
    const blockedDrawer = page.locator(
      '[data-dashboard-floating-layer="request-observation-drawer"]',
    );
    await expect(blockedDrawer).toBeVisible();
    await expect(
      blockedDrawer.getByText("请求详情", { exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(blockedDrawer).toBeHidden();

    await expect(
      page.getByRole("link", { name: "统计请求", exact: true }),
    ).toHaveAttribute(
      "href",
      "/zh/app/manage/request-observation?requestTab=included",
    );
    await page.goto("/zh/app/manage/request-observation?requestTab=included", {
      waitUntil: "commit",
    });
    await expect(page.getByText("最近统计请求", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "国家/地区", exact: true }).last(),
    ).toBeVisible();
  });

  test("22. administrator version updates render local release data in the client", async ({
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
