import { expect, test } from "@playwright/test";

import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

export function registerPerceptionScenarios(context: E2eContext) {
  test("12p. Perception Search keyboard and mobile entry respect the authorized site", async ({
    page,
  }) => {
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
      name: /搜索指标和分析页面/u,
    });
    await trigger.click();
    await expect(search).toBeVisible();
    await expect(page.getByRole("group", { name: "指标" })).toBeVisible();
    await expect(page.getByRole("group", { name: "本机观察" })).toHaveCount(0);
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
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(search).toBeVisible();
    await expect(page.getByRole("group", { name: "指标" })).toBeVisible();
    await expect(page.getByRole("group", { name: "本机观察" })).toHaveCount(0);
    await search.fill("跳出率");
    await expect(page.getByRole("option").first()).toBeVisible();
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
    await tab.goto(route, { waitUntil: "domcontentloaded" });
    await expect(tab.getByTestId("perception-search-trigger")).toBeVisible();
    await expect(tab.locator("[data-page-transition]").first()).toHaveAttribute(
      "data-page-transition-ready",
      "true",
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
    // The cross-tab clear invalidates the local session, so the palette must
    // fall back to its unauthenticated/root context without stale entries.
    const input = tab.getByRole("combobox", { name: /搜索团队/u });
    // Previously observed pages must disappear even if their IndexedDB
    // deletion was still pending when the dialog opened.
    await input.fill("/product");
    await expect(tab.getByRole("option")).toHaveCount(0);
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
    await expect(
      page.getByRole("row", { name: /查看详情: \/product/u }),
    ).toBeVisible();
    // The authorized Analytics response populates the index, not a fixture.
    await page.getByTestId("perception-search-trigger").click();
    const global = page.getByRole("combobox", {
      name: /搜索指标和分析页面/u,
    });
    await global.fill("/product");
    await expect(page.getByRole("option", { name: /product/u })).toBeVisible();
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

    await expect(trigger).toHaveText(/搜索指标和分析页面/u);
    await trigger.click();
    const metricsInput = page.getByRole("combobox", {
      name: /搜索指标和分析页面/u,
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

  test("12t. revoked search action cannot navigate and cross-tab scope clear hides stale observations", async ({
    page,
  }) => {
    const team = context.seed.teams.teamA!;
    const site = context.seed.sites.siteA!;
    const slug = site.domain
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const route = "/zh/app/" + team.slug + "/" + slug + "/pages";
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("row", { name: /查看详情: \/product/u }),
    ).toBeVisible();
    await page.getByTestId("perception-search-trigger").click();
    const search = page.getByRole("combobox", {
      name: /搜索指标和分析页面/u,
    });
    await search.fill("/product");
    const option = page.getByRole("option", { name: /product/u });
    await expect(option).toBeVisible();
    // Both tabs must hold an authorized observation BEFORE revocation.
    const tab = await page.context().newPage();
    await tab.goto(route, { waitUntil: "domcontentloaded" });
    const tabTrigger = tab.getByTestId("perception-search-trigger");
    await expect(tabTrigger).toBeVisible();
    await expect(tab.locator("[data-page-transition]").first()).toHaveAttribute(
      "data-page-transition-ready",
      "true",
    );
    await tabTrigger.click();
    const input = tab.getByRole("combobox", { name: /搜索指标和分析页面/u });
    await expect(input).toBeVisible();
    await input.fill("/product");
    await expect(tab.getByRole("option", { name: /product/u })).toBeVisible();
    // A live authorization endpoint can revoke access after the index was populated.
    await page.route("**/api/private/admin/sites?**", async (request) => {
      await request.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: [] }),
      });
    });
    await option.click();
    await expect(page.getByText("目标已失效或当前无权访问。")).toBeVisible();
    await expect(option).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(route);
    // The real revoke action also broadcasts the exact scope to the other tab.
    await expect(tab.getByRole("option", { name: /product/u })).toHaveCount(0);
    await page.unroute("**/api/private/admin/sites?**");
    await page.keyboard.press("Escape");
    await tab.close();
  });
}
