import { expect, test } from "@playwright/test";

import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

export function registerPerceptionScenarios(context: E2eContext) {
  test("12p. Perception Search keyboard and mobile entry respect the authorized site", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const team = context.seed.teams.teamA;
    const site = context.seed.sites.siteA;
    expect(team).toBeDefined();
    expect(site).toBeDefined();
    const slug = site!.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const route = "/zh/app/" + team!.slug + "/" + slug;
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto(route, { waitUntil: "domcontentloaded" });
    const trigger = page.getByTestId("perception-search-trigger");
    const teamTrigger = page
      .locator('button[data-slot="select-trigger"]')
      .first();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("data-slot", "select-trigger");
    await expect(trigger.locator("svg")).toHaveCount(1);
    await expect
      .poll(async () => {
        const teamBox = await teamTrigger.boundingBox();
        const searchBox = await trigger.boundingBox();
        return Boolean(teamBox && searchBox && searchBox.y > teamBox.y);
      })
      .toBe(true);
    await expect(
      page.locator("[data-page-transition]").first(),
    ).toHaveAttribute("data-page-transition-ready", "true");
    const search = page.getByRole("combobox", {
      name: /搜索页面、指标或数据/u,
    });
    await trigger.click();
    await expect(search).toBeVisible();
    await expect(page.getByRole("group", { name: "指标" })).toBeVisible();
    await expect(page.getByRole("group", { name: "数据" })).toHaveCount(0);
    const resultsContainer = page
      .locator("#perception-search-results")
      .locator("xpath=../..");
    const fullHeight = await resultsContainer.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(fullHeight).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).toBeVisible();
    await search.fill("跳出率");
    await expect(
      page
        .getByRole("group", { name: "指标" })
        .getByRole("option", { name: /跳出率/u }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "站点" })).toHaveCount(0);
    await expect
      .poll(() =>
        resultsContainer.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      )
      .toBeLessThan(fullHeight);
    const beforeClose = await page
      .locator("#perception-search-results [role=option]")
      .count();
    expect(beforeClose).toBeGreaterThan(0);
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      if (!dialog) throw new Error("Search dialog not found");
      const state = window as Window & { __searchClosingRows?: number };
      state.__searchClosingRows = -1;
      const observer = new MutationObserver(() => {
        if (dialog.getAttribute("data-state") === "closed") {
          state.__searchClosingRows = dialog.querySelectorAll(
            "#perception-search-results [role=option]",
          ).length;
          observer.disconnect();
        }
      });
      observer.observe(dialog, {
        attributes: true,
        attributeFilter: ["data-state"],
      });
    });
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __searchClosingRows?: number })
              .__searchClosingRows,
        ),
      )
      .toBe(beforeClose);
    await expect(search).not.toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(search).toBeVisible();
    await expect(page.getByRole("group", { name: "指标" })).toBeVisible();
    await expect(page.getByRole("group", { name: "数据" })).toHaveCount(0);
    await search.click();
    await expect(search).toBeFocused();
    await page.keyboard.type("bounce");
    await expect(search).toHaveValue("bounce");
    await search.fill("跳出率");
    await expect(page.getByRole("option").first()).toBeVisible();
    await search.fill("event:" + "a".repeat(513));
    await expect(page.getByText("无法按这个值查找")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /搜索全部数据/u }),
    ).toHaveCount(0);
  });

  test("12q. IndexedDB only stores whitelisted observations from real loaded Analytics", async ({
    page,
  }) => {
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto("/zh/app/" + team.slug + "/" + slug + "/pages", {
      waitUntil: "domcontentloaded",
    });
    const trigger = page.getByTestId("perception-search-trigger");
    await expect(trigger).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            if (!dbs.some((db) => db.name === "insightflare-perception-v1"))
              return 0;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open("insightflare-perception-v1");
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            const items = await new Promise<
              Array<{
                field: string;
                value: string;
                scope: { userId: string; siteId: string };
              }>
            >((resolve, reject) => {
              const tx = db.transaction("values", "readonly");
              const req = tx.objectStore("values").getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            db.close();
            return items.length;
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const result = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("insightflare-perception-v1");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const entries = await new Promise<
        Array<{
          field: string;
          value: string;
          scope: { userId: string; siteId: string };
        }>
      >((resolve, reject) => {
        const tx = db.transaction("values", "readonly");
        const req = tx.objectStore("values").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return entries.map(({ field, value, scope }) => ({
        field,
        value,
        scope,
      }));
    });
    expect(result.length).toBeGreaterThan(0);
    expect(
      result.every(
        (item) =>
          [
            "page.path",
            "referrer.domain",
            "event.name",
            "utm.source",
            "utm.medium",
            "utm.campaign",
            "client.browser",
          ].includes(item.field) &&
          item.scope.userId === context.seed.users.ownerA!.id &&
          item.scope.siteId === site.id &&
          !/[?@]/u.test(item.value),
      ),
    ).toBe(true);
  });

  test("12r. upgrades legacy observations and broadcasts permission cleanup across tabs", async ({
    page,
  }) => {
    const user = context.seed.users.ownerA!;
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const route = "/zh/app/" + team.slug + "/" + slug + "/pages";
    await page.goto("/zh/login", { waitUntil: "domcontentloaded" });
    // The legacy IndexedDB schema has only values; the current schema adds meta.
    // Seed a different user's record to verify real migration and user isolation.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("insightflare-perception-v1", 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore("values", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("values", "readwrite");
        tx.objectStore("values").put({
          id: "legacy-test",
          kind: "event",
          field: "event.name",
          value: "Legacy",
          scope: {
            userId: "obsolete-user",
            teamId: "old-team",
            siteId: "old-site",
          },
          observedAt: Date.now(),
          observeCount: 1,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("perception-search-trigger")).toBeVisible();

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            if (
              !dbs.some(
                (item) =>
                  item.name === "insightflare-perception-v1" &&
                  item.version === 2,
              )
            )
              return undefined;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open("insightflare-perception-v1");
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            if (!db.objectStoreNames.contains("meta")) {
              db.close();
              return undefined;
            }
            const value = await new Promise<string | undefined>(
              (resolve, reject) => {
                const tx = db.transaction("meta", "readonly");
                const req = tx.objectStore("meta").get("activeUserId");
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              },
            );
            db.close();
            return value;
          }),
        { timeout: 20_000 },
      )
      .toBe(user.id);
    const inspection = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("insightflare-perception-v1");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const result = await new Promise<{
        version: number;
        stores: string[];
        owners: string[];
      }>((resolve, reject) => {
        const tx = db.transaction("values", "readonly");
        const req = tx.objectStore("values").getAll();
        req.onsuccess = () =>
          resolve({
            version: db.version,
            stores: Array.from(db.objectStoreNames),
            owners: (req.result as Array<{ scope: { userId: string } }>).map(
              (record) => record.scope.userId,
            ),
          });
        req.onerror = () => reject(req.error);
      });
      db.close();
      return result;
    });
    expect(inspection.version).toBe(2);
    expect(inspection.stores).toEqual(["meta", "values"]);
    expect(inspection.owners.length).toBeGreaterThan(0);
    expect(inspection.owners.every((id) => id === user.id)).toBe(true);

    const tab = await page.context().newPage();
    // The second tab must hydrate and register its transition handler before
    // broadcasting a revoke event. domcontentloaded only confirms SSR HTML.
    await tab.goto(route, { waitUntil: "load" });
    await expect(tab.getByTestId("perception-search-trigger")).toBeVisible();
    await expect(tab.locator("[data-page-transition]").first()).toHaveAttribute(
      "data-page-transition-ready",
      "true",
      { timeout: 20_000 },
    );
    // Simulate the session revocation message sent by a logout in another tab.
    await page.evaluate((userId) => {
      const broadcast = new BroadcastChannel("insightflare-perception-v1");
      broadcast.postMessage({ type: "clear", userId });
      broadcast.close();
    }, user.id);
    await expect
      .poll(
        async () =>
          tab.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open("insightflare-perception-v1");
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            const rows = await new Promise<unknown[]>((resolve, reject) => {
              const req = db
                .transaction("values", "readonly")
                .objectStore("values")
                .getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            db.close();
            return rows.length;
          }),
        { timeout: 15_000 },
      )
      .toBe(0);
    await tab.getByTestId("perception-search-trigger").click();
    // The cross-tab clear discards local observations but preserves the live
    // site grant. The site-scoped search must not expose stale local results.
    const input = tab.getByRole("combobox", {
      name: /搜索页面、指标或数据/u,
    });
    // Previously observed pages must disappear even if their IndexedDB
    // deletion was still pending when the dialog opened.
    await input.fill("/product");
    await expect(tab.getByRole("group", { name: "数据" })).toHaveCount(0);
    await expect(
      tab.getByRole("option", { name: /^在 .+ 中查找“\/product”页面/u }),
    ).toBeVisible();
    await tab.close();
  });

  test("12s. Filter Builder preserves server-ranked value suggestions without local suggestions", async ({
    page,
  }) => {
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto("/zh/app/" + team.slug + "/" + slug + "/pages", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("table").evaluate((table) => {
      table.scrollIntoView({ block: "start" });
    });
    await expect(
      page.getByRole("row", { name: /查看详情: \/product/u }),
    ).toBeVisible();
    // The authorized Analytics response populates the index, not a fixture.
    await page.getByTestId("perception-search-trigger").click();
    const global = page.getByRole("combobox", {
      name: /搜索页面、指标或数据/u,
    });
    await global.fill("/product");
    await expect(
      page.getByRole("option", { name: /^\/product/u }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "筛选", exact: true })
      .first()
      .click();
    const panel = page.getByRole("dialog", { name: "筛选条件" });
    await expect(panel).toBeVisible();
    const add = panel.getByRole("button", { name: "添加条件" }).first();
    if (await add.count()) await add.click();
    const picker = panel
      .getByRole("button", { name: /^(页面路径|事件名称)$/u })
      .last();
    await expect(picker).toBeVisible();
    await picker.click();
    const field = page
      .getByRole("button", { name: "页面路径", exact: true })
      .last();
    await expect(field).toBeVisible();
    await field.click();
    await panel
      .getByRole("button", { name: /未设置/u })
      .last()
      .click();
    await expect(
      page.getByText("本机曾观察到的值", { exact: true }),
    ).toHaveCount(0);
    // The existing server-ranked list is shown without inserting local values.
    const remoteValue = page
      .getByRole("button", {
        name: /^\/product(?:\s+\d+)?$/u,
      })
      .last();
    await expect(remoteValue).toBeVisible();
    await remoteValue.click();
    await expect(
      panel.getByRole("button", { name: "/product", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect.poll(() => page.url()).toContain("/pages");
    await expect(
      page.getByRole("row", { name: /查看详情: \/product/u }),
    ).toBeVisible();
  });

  test("12u. Team command search opens a site and an exact overview metric", async ({
    page,
  }) => {
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto("/zh/app/" + team.slug, { waitUntil: "domcontentloaded" });
    const trigger = page.getByTestId("perception-search-trigger");
    await expect(trigger).toHaveText(/搜索站点/u);
    await trigger.click();
    const input = page.getByRole("combobox", { name: /搜索站点/u });
    await expect(page.getByRole("group", { name: "站点" })).toBeVisible();
    await expect(page.getByRole("group", { name: "指标" })).toHaveCount(0);
    await input.fill(site.domain);
    const siteOption = page
      .getByRole("group", { name: "站点" })
      .getByRole("option", { name: /E2E Analytics Site A/u });
    await expect(siteOption).toBeVisible();
    await siteOption.click();
    await expect(page).toHaveURL(
      new RegExp("/zh/app/" + team.slug + "/" + slug + "(?:$|[?#])"),
    );

    await expect(trigger).toHaveText(/搜索页面、指标或数据/u);
    await trigger.click();
    const metricsInput = page.getByRole("combobox", {
      name: /搜索页面、指标或数据/u,
    });
    await expect(page.getByRole("group", { name: "指标" })).toBeVisible();
    await expect(page.getByRole("group", { name: "分析页面" })).toBeVisible();
    await metricsInput.fill("bounce rate");
    const metricOption = page
      .getByRole("group", { name: "指标" })
      .getByRole("option", { name: /跳出率/u });
    await expect(metricOption).toBeVisible();
    await metricOption.click();
    await expect(page).toHaveURL(/#overview-metric-bounceRate$/u);
    await expect(page.locator("#overview-metric-bounceRate")).toBeVisible();
  });

  test("12v. Search type filters and typing keep server lookups explicit", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const uuid = "f2b07f9c-8a13-4c26-9f98-3f5bc63aee9c";
    const requests: URL[] = [];
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto("/zh/app/" + team.slug + "/" + slug, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator("[data-page-transition]").first(),
    ).toHaveAttribute("data-page-transition-ready", "true", {
      timeout: 20_000,
    });
    await page.route(
      /\/api\/private\/(?:visitor|session|event-record)-detail\?/u,
      async (route) => {
        requests.push(new URL(route.request().url()));
        await route.fulfill({ json: { ok: true, data: null } });
      },
    );
    await page.getByTestId("perception-search-trigger").click();
    const input = page.getByRole("combobox", { name: /搜索页面、指标或数据/u });
    const types = page.getByRole("toolbar", { name: "数据" });
    await types.getByRole("button", { name: "访客", exact: true }).click();
    await expect(input).toBeFocused();
    await input.fill(uuid);
    await expect(
      page.getByRole("option", { name: /^在 .+ 中查找“.+”访客/u }),
    ).toBeVisible();
    expect(requests).toHaveLength(0);
    await input.press("Enter");
    await expect(page.getByText("没有找到匹配的数据")).toBeVisible();
    expect(requests.map((url) => url.pathname)).toEqual([
      "/api/private/visitor-detail",
    ]);
    expect(requests[0].searchParams.get("visitorId")).toBe(uuid);

    await types.getByRole("button", { name: "全部", exact: true }).click();
    await expect(
      page.getByRole("option", { name: /访客或事件记录/u }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
    await input.press("Enter");
    await expect(page.getByText("没有找到匹配的数据")).toBeVisible();
    expect(
      requests
        .slice(1)
        .map((url) => url.pathname)
        .sort(),
    ).toEqual([
      "/api/private/event-record-detail",
      "/api/private/visitor-detail",
    ]);
    expect(
      requests.every((url) => url.searchParams.get("siteId") === site.id),
    ).toBe(true);

    await input.fill("page:/product");
    const [exactResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/private/filter-values" &&
          url.searchParams.get("exact") === "true"
        );
      }),
      input.press("Enter"),
    ]);
    expect(exactResponse.ok()).toBe(true);
    const dataResults = page.getByRole("group", { name: "数据" });
    const found = dataResults.getByRole("option", {
      name: /^\/product(?![\w/-])/u,
    });
    await expect(found).toBeVisible();
    await found.click();
    await expect(page).toHaveURL(/\/pages\?pagePath=%2Fproduct/u);
  });

  test("12t. revoked search action cannot navigate and cross-tab scope clear hides stale observations", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const route = "/zh/app/" + team.slug + "/" + slug + "/pages";
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.getByRole("table").evaluate((table) => {
      table.scrollIntoView({ block: "start" });
    });
    await expect(
      page.getByRole("row", { name: /查看详情: \/product/u }),
    ).toBeVisible();
    await page.getByTestId("perception-search-trigger").click();
    const search = page.getByRole("combobox", {
      name: /搜索页面、指标或数据/u,
    });
    await search.fill("/product");
    const option = page.getByRole("option", { name: /^\/product/u });
    await expect(option).toBeVisible();
    // Both tabs must hold an authorized observation BEFORE revocation.
    const tab = await page.context().newPage();
    await tab.goto(route, { waitUntil: "domcontentloaded" });
    const tabTrigger = tab.getByTestId("perception-search-trigger");
    await expect(tabTrigger).toBeVisible();
    await expect(tab.locator("[data-page-transition]").first()).toHaveAttribute(
      "data-page-transition-ready",
      "true",
      { timeout: 20_000 },
    );
    await tabTrigger.click();
    const input = tab.getByRole("combobox", { name: /搜索页面、指标或数据/u });
    await expect(input).toBeVisible();
    await input.fill("/product");
    await expect(
      tab.getByRole("option", { name: /^\/product/u }),
    ).toBeVisible();
    // A live authorization endpoint can revoke access after the index was populated.
    await page.route("**/api/private/admin/sites?**", async (request) => {
      await request.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: [] }),
      });
    });
    await option.click();
    await expect(
      page.getByText("目标已不存在，或你已无权访问。"),
    ).toBeVisible();
    await expect(option).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(route);
    // The real revoke action also broadcasts the exact scope to the other tab.
    await expect(tab.getByRole("option", { name: /^\/product/u })).toHaveCount(
      0,
    );
    await page.unroute("**/api/private/admin/sites?**");
    await page.keyboard.press("Escape");
    await tab.close();
  });
}
