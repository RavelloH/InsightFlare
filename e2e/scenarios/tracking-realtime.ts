import { type Browser, expect, type Page, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn, waitForCollectResponse } from "../support/browser";
import type {
  DashboardPage,
  E2eContext,
  EventType,
} from "../support/flow-context";

export function registerTrackingRealtimeScenarios(context: E2eContext) {
  const {
    adminPassword,
    browserNowMs,
    flushSite,
    readSiteOverview,
    saveManifest,
    seed,
    siteQueryPath,
    testSiteURL,
  } = context;
  const { ownerA: ownerAPassword } = context.passwords;

  test("10. real browser tracking reaches the DO and persists pageviews and events", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const trackingConfig = await apiRequest<Record<string, unknown>>(
      page,
      "POST",
      "/api/private/admin/site-config",
      {
        config: { domainWhitelist: ["127.0.0.1"] },
        siteId: siteA?.id || "",
      },
    );
    expect(trackingConfig.status).toBe(200);

    const collectPayloads: Array<{ kind?: string; pathname?: string }> = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/collect") || request.method() !== "POST")
        return;
      try {
        collectPayloads.push(
          JSON.parse(request.postData() || "{}") as {
            kind?: string;
            pathname?: string;
          },
        );
      } catch {
        // The request itself remains the authoritative browser-side evidence.
      }
    });
    await page.context().clearCookies();
    const initialCollect = waitForCollectResponse(page, {
      kind: "pageview",
      pathname: "/",
    });
    await page.goto(
      `${testSiteURL}/?siteId=${encodeURIComponent(siteA?.id || "")}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect((await initialCollect).status()).toBe(204);
    await expect(page.locator("#signup")).toBeVisible();
    const signupCollect = waitForCollectResponse(page, {
      kind: "custom_event",
      pathname: "/",
    });
    await page.locator("#signup").click();
    expect((await signupCollect).status()).toBe(204);
    const spaCollect = waitForCollectResponse(page, {
      kind: "pageview",
      pathname: "/spa/checkout",
    });
    await page.locator("#spa-route").click();
    await expect(page).toHaveURL(/\/spa\/checkout\?siteId=/);
    expect((await spaCollect).status()).toBe(204);
    const productCollect = waitForCollectResponse(page, {
      kind: "pageview",
      pathname: "/product",
    });
    await page.locator("#product-link").click();
    await expect(page).toHaveURL(/\/product\?siteId=/);
    expect((await productCollect).status()).toBe(204);
    await expect
      .poll(
        () =>
          collectPayloads.filter((entry) => entry.kind === "pageview").length,
      )
      .toBeGreaterThanOrEqual(3);
    expect(collectPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "custom_event", pathname: "/" }),
        expect.objectContaining({
          kind: "pageview",
          pathname: "/spa/checkout",
        }),
        expect.objectContaining({ kind: "pageview", pathname: "/product" }),
      ]),
    );

    await signIn(page, "admin", adminPassword);
    await flushSite(page, siteA?.id || "");
    const performance = await apiRequest<unknown>(
      page,
      "GET",
      "/api/private/admin/system-performance?minutes=15",
    );
    expect(performance.status).toBe(200);
    const systemPerformance = performance.payload as unknown as {
      summary?: { customEvents?: number; visits?: number };
    };
    expect(systemPerformance.summary?.visits).toBeGreaterThanOrEqual(1);
    expect(systemPerformance.summary?.customEvents).toBeGreaterThanOrEqual(1);

    const pageviews = collectPayloads
      .filter(
        (entry): entry is { kind: "pageview"; pathname: string } =>
          entry.kind === "pageview" && typeof entry.pathname === "string",
      )
      .map((entry) => entry.pathname);
    const customEvents = collectPayloads
      .filter(
        (entry): entry is { kind: "custom_event"; pathname: string } =>
          entry.kind === "custom_event" && typeof entry.pathname === "string",
      )
      .map((entry) => ({
        eventName: "signup_clicked",
        pathname: entry.pathname,
      }));
    expect(pageviews).toEqual(["/", "/spa/checkout", "/product"]);
    expect(customEvents).toEqual([
      { eventName: "signup_clicked", pathname: "/" },
    ]);
    seed.tracker = {
      siteA: {
        customEvents,
        overview: { views: pageviews.length },
        pageviews,
      },
    };
    await saveManifest();
  });

  test("11. realtime websocket receives a visitor before the durable object flush", async ({
    browser,
    page,
  }: {
    browser: Browser;
    page: Page;
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    const expected = seed.tracker?.siteA;
    expect(siteA).toBeDefined();
    expect(expected).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const initialSnapshot = await page.evaluate(
      (siteId) =>
        new Promise<{ activeNow: number | null }>((resolve, reject) => {
          const state = window as Window & {
            __e2eRealtime?: { messages: unknown[]; socket: WebSocket };
          };
          const socket = new WebSocket(
            `${location.origin.replace(/^http/, "ws")}/api/private/realtime/ws?siteId=${encodeURIComponent(siteId)}`,
          );
          const messages: unknown[] = [];
          state.__e2eRealtime = { messages, socket };
          const timeout = window.setTimeout(() => {
            socket.close();
            reject(
              new Error("Realtime websocket did not send an initial snapshot."),
            );
          }, 10_000);
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
              data?: { activeNow?: number | null };
              type?: string;
            };
            messages.push(message);
            if (message.type !== "snapshot") return;
            window.clearTimeout(timeout);
            resolve({ activeNow: message.data?.activeNow ?? null });
          });
          socket.addEventListener("error", () => {
            window.clearTimeout(timeout);
            reject(new Error("Realtime websocket failed to connect."));
          });
        }),
      siteA?.id || "",
    );
    expect(initialSnapshot.activeNow).toEqual(expect.any(Number));

    const visitorContext = await browser.newContext();
    try {
      const visitorPage = await visitorContext.newPage();
      const collected = waitForCollectResponse(visitorPage, {
        kind: "pageview",
        pathname: "/realtime",
      });
      await visitorPage.goto(
        `${testSiteURL}/realtime?siteId=${encodeURIComponent(siteA?.id || "")}`,
        { waitUntil: "domcontentloaded" },
      );
      expect((await collected).status()).toBe(204);

      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = window as Window & {
              __e2eRealtime?: {
                messages: Array<{
                  data?: { pathname?: string };
                  type?: string;
                }>;
              };
            };
            return state.__e2eRealtime?.messages.some(
              (message) =>
                message.type === "event" &&
                message.data?.pathname === "/realtime",
            );
          }),
        )
        .toBe(true);
    } finally {
      await visitorContext.close();
    }

    await flushSite(page, siteA?.id || "");
    expected?.pageviews.push("/realtime");
    if (expected) expected.overview.views = expected.pageviews.length;
    await saveManifest();
    expect(await readSiteOverview(page, siteA?.id || "")).toMatchObject(
      expected?.overview || {},
    );
    await page.evaluate(() => {
      const state = window as Window & {
        __e2eRealtime?: { socket: WebSocket };
      };
      state.__e2eRealtime?.socket.close();
      delete state.__e2eRealtime;
    });
  });

  test("12. site analytics API and dashboard render the real tracker manifest", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    const teamA = seed.teams.teamA;
    const expected = seed.tracker?.siteA;
    expect(siteA).toBeDefined();
    expect(teamA).toBeDefined();
    expect(expected).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const overview = await readSiteOverview(page, siteA?.id || "");
    expect(overview.views).toBe(expected?.overview.views);

    const pages = await apiRequest<DashboardPage[]>(
      page,
      "GET",
      siteQueryPath(siteA?.id || "", "pages"),
      undefined,
      "no-store",
    );
    expect(pages.status).toBe(200);
    expect(pages.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pathname: "/", views: 1 }),
        expect.objectContaining({ pathname: "/spa/checkout", views: 1 }),
        expect.objectContaining({ pathname: "/product", views: 1 }),
      ]),
    );

    const eventTypes = await apiRequest<EventType[]>(
      page,
      "GET",
      siteQueryPath(siteA?.id || "", "event-types"),
      undefined,
      "no-store",
    );
    expect(eventTypes.status).toBe(200);
    expect(eventTypes.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "signup_clicked", views: 1 }),
      ]),
    );

    await page.goto(`/zh/app/${teamA?.slug}/analytics-a-example-test`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText(String(expected?.overview.views), { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator('[data-geo-map-mode="flat"]')).toBeVisible({
      timeout: 15_000,
    });

    const dashboardSsr = await page.request.get(
      `/zh/app/${teamA?.slug}/analytics-a-example-test`,
    );
    expect(dashboardSsr.status()).toBe(200);
    const dashboardHtml = await dashboardSsr.text();
    expect(dashboardHtml).toContain(siteA?.name || "");
    expect(dashboardHtml).not.toContain(
      'aria-busy="true" aria-label="Loading"',
    );

    await page.goto(`/zh/app/${teamA?.slug}/analytics-a-example-test/pages`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "页面分析" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "查看详情: /", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("13. bot and invalid collect requests do not change normal site analytics", async ({
    browser,
    page,
  }: {
    browser: Browser;
    page: Page;
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    const expected = seed.tracker?.siteA;
    expect(siteA).toBeDefined();
    expect(expected).toBeDefined();

    await signIn(page, "admin", adminPassword);
    const before = await readSiteOverview(page, siteA?.id || "");
    expect(before.views).toBe(expected?.overview.views);

    const botContext = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; Googlebot/2.1; +https://www.google.com/bot.html)",
    });
    try {
      const botPage = await botContext.newPage();
      let botCollects = 0;
      botPage.on("request", (request) => {
        if (request.url().endsWith("/collect") && request.method() === "POST") {
          botCollects += 1;
        }
      });
      await botPage.goto(
        `${testSiteURL}/?siteId=${encodeURIComponent(siteA?.id || "")}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect.poll(() => botCollects).toBeGreaterThanOrEqual(1);
    } finally {
      await botContext.close();
    }

    const invalidCollectStatus = await page.evaluate(
      async ({ siteId, timestamp }) => {
        const response = await fetch("/collect", {
          body: JSON.stringify({
            collectToken: "not-a-valid-e2e-collect-token",
            hostname: "127.0.0.1",
            kind: "pageview",
            pathname: "/invalid-token",
            siteId,
            timestamp,
            visitId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return response.status;
      },
      { siteId: siteA?.id || "", timestamp: browserNowMs() },
    );
    expect(invalidCollectStatus).toBe(204);

    await flushSite(page, siteA?.id || "");
    const after = await readSiteOverview(page, siteA?.id || "");
    expect(after).toEqual(before);
  });
}
