import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext, User } from "../support/flow-context";

export function registerBootstrapScenarios(context: E2eContext) {
  test("1. bootstrap administrator can authenticate with a real session", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, "admin", context.adminPassword);

    const health = await page.request.get("/healthz");
    expect(health.ok()).toBe(true);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/zh\/app\/[^/]+\/?$/);

    const session = await apiRequest<{ user?: User }>(
      page,
      "GET",
      "/api/private/session",
    );
    expect(session.status).toBe(200);
    expect(session.payload.ok).toBe(true);
    expect(session.payload.data?.user).toMatchObject({
      systemRole: "admin",
      username: "admin",
    });
    context.seed.users.admin = session.payload.data?.user;
    await context.saveManifest();
  });
}
