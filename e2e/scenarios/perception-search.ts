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
    await expect(trigger).toBeVisible();
    await expect(
      page.locator("[data-page-transition]").first(),
    ).toHaveAttribute("data-page-transition-ready", "true");
    const search = page.getByRole("combobox", {
      name: /搜索页面、事件和导航/u,
    });
    await trigger.click();
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).toBeVisible();
    await search.fill("E2E");
    await expect(page.getByRole("option").first()).toBeVisible();
    await expect(
      page.getByRole("option", { name: /E2E Team A/u }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).not.toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(search).toBeVisible();
    await search.fill("E2E");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.getByRole("button", { name: /搜索全部数据/u }).click();
    await expect(page.getByText(/尚无可用的服务端全文搜索/u)).toBeVisible();
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
    const input = tab.getByRole("combobox", { name: /搜索页面、事件和导航/u });
    // Static team navigation may remain authorized until server logout; it is
    // not an observed Analytics entry. The previously observed path must vanish.
    await input.fill("/product");
    await expect(tab.getByRole("option")).toHaveCount(0);
    await tab.close();
  });
}
