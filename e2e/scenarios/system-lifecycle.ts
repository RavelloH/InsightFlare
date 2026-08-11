import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

export function registerSystemLifecycleScenarios(context: E2eContext) {
  const {
    adminPassword,
    advanceE2eClock,
    e2eControlRequest,
    e2eNowMs,
    flushSite,
    readSiteOverview,
    seed,
  } = context;
  test("24. E2E clock is token-protected and can expire an existing session", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, "admin", adminPassword);

    const siteA = seed.sites.siteA;
    expect(siteA).toBeDefined();
    const ingestStatus = await e2eControlRequest<{ visits?: unknown }>(
      page,
      "GET",
      `ingest/status?siteId=${encodeURIComponent(siteA?.id || "")}`,
    );
    expect(ingestStatus.status).toBe(200);
    expect(ingestStatus.payload?.ok).toBe(true);

    const scheduled = await e2eControlRequest<{ scheduledAt: number }>(
      page,
      "POST",
      "scheduled/run",
      { key: "visit_hourly_rollup" },
    );
    expect(scheduled.status).toBe(200);
    expect(scheduled.payload?.data?.scheduledAt).toEqual(expect.any(Number));
    const scheduledTasks = await apiRequest<{
      tasks?: Array<{ key: string; runs?: number }>;
    }>(page, "GET", "/api/private/admin/scheduled-tasks");
    expect(scheduledTasks.status).toBe(200);

    const missingToken = await e2eControlRequest<unknown>(
      page,
      "GET",
      "clock",
      undefined,
      "wrong-token",
    );
    expect(missingToken.status).toBe(404);

    const before = await e2eControlRequest<{ nowMs: number | null }>(
      page,
      "GET",
      "clock",
    );
    expect(before.status).toBe(200);
    const beforeNowMs = before.payload?.data?.nowMs;
    expect(beforeNowMs).toBe(e2eNowMs + 2 * 60 * 60_000);
    if (typeof beforeNowMs !== "number") {
      throw new Error("E2E clock did not return a timestamp.");
    }

    const collectToken = await page.evaluate(async (siteId) => {
      const script = await fetch(
        `/script.js?siteId=${encodeURIComponent(siteId)}`,
        { cache: "no-store" },
      ).then((response) => response.text());
      return script.match(/collectToken:"([^"\\]+)"/)?.[1] || "";
    }, siteA?.id || "");
    expect(collectToken).not.toBe("");

    const analyticsBeforeExpiredToken = await readSiteOverview(
      page,
      siteA?.id || "",
    );
    const tokenExpiredAt = await advanceE2eClock(page, 13 * 60 * 60 * 1000);
    expect(tokenExpiredAt).toBe(beforeNowMs + 13 * 60 * 60 * 1000);

    const expiredCollectStatus = await page.evaluate(
      async ({ collectToken, siteId, timestamp }) => {
        const response = await fetch("/collect", {
          body: JSON.stringify({
            collectToken,
            hostname: "history.e2e.test",
            kind: "pageview",
            pathname: "/expired-token",
            siteId,
            timestamp,
            visitId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return response.status;
      },
      { collectToken, siteId: siteA?.id || "", timestamp: e2eNowMs },
    );
    expect(expiredCollectStatus).toBe(204);
    await flushSite(page, siteA?.id || "");
    expect(await readSiteOverview(page, siteA?.id || "")).toEqual(
      analyticsBeforeExpiredToken,
    );

    const advanced = await advanceE2eClock(page, 31 * 24 * 60 * 60 * 1000);
    expect(advanced).toBe(
      beforeNowMs + 13 * 60 * 60 * 1000 + 31 * 24 * 60 * 60 * 1000,
    );

    const expired = await apiRequest<unknown>(
      page,
      "GET",
      "/api/private/session",
    );
    expect(expired.status).toBe(401);
  });
}
