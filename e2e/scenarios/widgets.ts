import { expect, type Page, test } from "@playwright/test";

import type { WidgetData, WidgetRecord } from "@/lib/widgets/contract";

import { apiRequest, type OverviewMetrics } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

async function mountWidget(
  page: Page,
  src: string,
  referrerPolicy?: "no-referrer",
) {
  await page.evaluate(
    ({ src, referrerPolicy }) => {
      const iframe = document.createElement("iframe");
      iframe.title = "Widget";
      iframe.width = "240";
      iframe.height = "160";
      if (referrerPolicy) iframe.referrerPolicy = referrerPolicy;
      iframe.src = src;
      document.body.appendChild(iframe);
    },
    { src, referrerPolicy },
  );
}

export function registerWidgetScenarios(context: E2eContext) {
  test("12w. Widget publication serves only the saved aggregate in a cross-origin iframe", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const team = context.seed.teams.teamA!;
    const otherSite = context.seed.sites.siteC!;
    const creationToken = crypto.randomUUID();
    const teamApi = `/api/private/widgets/teams/${team.id}`;
    const host = new URL(context.testSiteURL).origin;
    const config = {
      title: "Published site visits",
      type: "metric",
      metric: "views",
      range: "7d",
      timeZone: "America/New_York",
      locale: "en",
      theme: "dark",
      embedMode: "restricted",
      allowedOrigins: [host],
      comparison: true,
      dimension: "page.path",
      limit: 5,
    };
    await signIn(page, "owner-a", context.passwords.ownerA);
    const siteResponse = await apiRequest<{ id: string }>(
      page,
      "POST",
      "/api/private/admin/sites",
      { teamId: team.id, name: "Widget test site", domain: "widgets.e2e.test" },
    );
    expect(siteResponse.status).toBe(200);
    const site = siteResponse.payload.data!;
    await context.seedHistoricalVisits(page, site.id);

    const preview = await apiRequest<WidgetData>(
      page,
      "POST",
      `${teamApi}/preview`,
      {
        siteId: site.id,
        config,
      },
    );
    expect(preview.status).toBe(200);
    expect(preview.payload.data).toMatchObject({
      type: "metric",
      timeZone: config.timeZone,
    });
    const invalidSite = await apiRequest<WidgetRecord>(page, "POST", teamApi, {
      uuid: creationToken,
      siteId: otherSite.id,
      config,
    });
    expect(invalidSite.status).toBe(404);

    const created = await apiRequest<WidgetRecord>(page, "POST", teamApi, {
      uuid: creationToken,
      siteId: site.id,
      config,
    });
    expect(created.status).toBe(201);
    const { uuid } = created.payload.data!;
    const management = `${teamApi}/${uuid}`;
    const widgetUrl = new URL(`/widget/${uuid}`, baseURL).href;
    const dataUrl = new URL(`/api/public/widgets/${uuid}/data`, baseURL).href;

    const visitor = await browser.newContext({ baseURL });
    try {
      expect((await visitor.request.get(widgetUrl)).status()).toBe(404);
      expect((await visitor.request.get(dataUrl)).status()).toBe(404);
      const published = await apiRequest<WidgetRecord>(
        page,
        "POST",
        `${management}/publish`,
      );
      expect(published.status).toBe(200);
      const revision = published.payload.data!.revision;

      const response = await visitor.request.get(
        `${dataUrl}?siteId=${otherSite.id}&metric=sessions&range=30d`,
      );
      expect(response.status()).toBe(200);
      const payload = (await response.json()) as { data: WidgetData };
      expect(payload.data).toMatchObject({ type: "metric", metric: "views" });
      expect(payload.data).not.toHaveProperty("siteId");
      const params = new URLSearchParams({
        siteId: site.id,
        from: String(payload.data.from),
        to: String(payload.data.to),
        timeZone: config.timeZone,
      });
      const privateOverview = await apiRequest<OverviewMetrics>(
        page,
        "GET",
        `/api/private/overview?${params}`,
      );
      expect(privateOverview.status).toBe(200);
      expect(privateOverview.payload.data!.views).toBeGreaterThan(0);
      expect(payload.data).toMatchObject({
        value: privateOverview.payload.data!.views,
      });

      const embedPage = await visitor.newPage();
      await embedPage.goto(`${host}/widget-e2e`);
      await mountWidget(embedPage, widgetUrl);
      const frame = embedPage.frameLocator('iframe[title="Widget"]');
      await expect(
        frame.getByText(config.title, { exact: true }),
      ).toBeVisible();
      await expect(
        frame.getByText(String(privateOverview.payload.data!.views), {
          exact: true,
        }),
      ).toBeVisible();

      const disallowedHost = new URL("/widget-e2e-host", host);
      disallowedHost.hostname = "localhost";
      await embedPage.goto(disallowedHost.href);
      const denied = embedPage.waitForResponse(
        (result) =>
          result.status() === 403 &&
          new URL(result.url()).pathname.endsWith(`/widget/${uuid}`),
      );
      await mountWidget(embedPage, widgetUrl);
      expect((await denied).status()).toBe(403);
      await expect(frame.getByText(config.title, { exact: true })).toHaveCount(
        0,
      );
      await embedPage.reload();
      const cspBlocked = embedPage.waitForEvent(
        "console",
        (message) =>
          message.type() === "error" &&
          message.text().includes("frame-ancestors"),
      );
      await mountWidget(embedPage, widgetUrl, "no-referrer");
      await cspBlocked;

      const modified = await apiRequest<WidgetRecord>(page, "PUT", management, {
        config: { ...config, type: "trend", title: "Daily site visits" },
      });
      expect(modified.status).toBe(200);
      expect(
        (
          await (
            await visitor.request.get(`${dataUrl}?revision=${revision}`)
          ).json()
        ).data.type,
      ).toBe("metric");
      expect(
        (await apiRequest(page, "POST", `${management}/publish`)).status,
      ).toBe(200);
      expect(
        (await visitor.request.get(`${dataUrl}?revision=${revision}`)).status(),
      ).toBe(409);
      expect(
        (await (await visitor.request.get(dataUrl)).json()).data.type,
      ).toBe("trend");

      expect(
        (
          await apiRequest(page, "PUT", management, {
            config: { ...config, type: "ranking", metric: "sessions" },
          })
        ).status,
      ).toBe(200);
      expect(
        (await apiRequest(page, "POST", `${management}/publish`)).status,
      ).toBe(200);
      const ranked = await visitor.request.get(dataUrl);
      expect(ranked.status()).toBe(200);
      expect((await ranked.json()).data).toMatchObject({
        type: "ranking",
        metric: "sessions",
        rows: expect.arrayContaining([
          expect.objectContaining({ label: expect.stringMatching(/^\//) }),
        ]),
      });

      expect(
        (await apiRequest(page, "POST", `${management}/unpublish`)).status,
      ).toBe(200);
      expect((await visitor.request.get(widgetUrl)).status()).toBe(410);
      expect((await visitor.request.get(dataUrl)).status()).toBe(410);
      expect(
        (await apiRequest(page, "POST", `${management}/publish`)).status,
      ).toBe(200);
      expect((await visitor.request.get(dataUrl)).status()).toBe(200);
      const removedSite = await apiRequest(
        page,
        "PATCH",
        "/api/private/admin/sites",
        {
          siteId: site.id,
          intent: "remove",
        },
      );
      expect(removedSite.status).toBe(200);
      expect((await visitor.request.get(widgetUrl)).status()).toBe(404);
      expect((await visitor.request.get(dataUrl)).status()).toBe(404);
      expect(
        await page.evaluate(
          async (path) => (await fetch(path, { method: "DELETE" })).status,
          management,
        ),
      ).toBe(204);
      expect((await visitor.request.get(widgetUrl)).status()).toBe(404);
      expect((await visitor.request.get(dataUrl)).status()).toBe(404);
    } finally {
      await visitor.close();
    }
  });

  test("12x. Widget editor previews and publishes from the team management page", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const team = context.seed.teams.teamA!;
    await signIn(page, "owner-a", context.passwords.ownerA);
    await page.goto(`/en/app/${team.slug}/widgets`);
    const create = page.getByRole("button", { name: "Create widget" });
    await expect(create).toBeEnabled({ timeout: 20_000 });
    await create.click();
    const editor = page.getByRole("dialog");
    await editor.getByLabel("Title").fill("Widget editor preview");
    await expect(editor.getByLabel("Allowed website origins")).not.toHaveValue(
      "",
    );
    // The current editor automatically refreshes the iframe preview.
    await expect(
      editor.frameLocator("iframe").first().getByText("Widget editor preview", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });

    await editor.getByRole("button", { name: "Publish", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation.getByText("Publish this widget?")).toBeVisible();
    await confirmation.getByRole("checkbox").check();
    await confirmation
      .getByRole("button", { name: "I understand, publish widget" })
      .click();
    const embedDialog = page.getByRole("dialog", { name: "Embed code" });
    await expect(embedDialog).toBeVisible();
    // Embed code is now a syntax-highlighted read-only viewer.
    await expect(embedDialog.locator("code")).toContainText(
      /<iframe src="[^"]+\/widget\/[\da-f-]+"/,
    );
    await expect(
      embedDialog.getByRole("button", { name: "Copy embed code" }),
    ).toBeVisible();
  });
}
