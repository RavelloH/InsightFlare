import { expect, type Locator, type Page, test } from "@playwright/test";

export async function openUiFixture(
  page: Page,
  component: string,
  fixtureId: string,
): Promise<Locator> {
  await page.goto("/zh/ui/" + component + "#" + fixtureId);
  const fixture = getUiFixture(page, fixtureId);
  await expect(fixture).toBeVisible();
  return fixture;
}

export function getUiFixture(page: Page, fixtureId: string): Locator {
  return page.locator('[data-ui-fixture="' + fixtureId + '"]');
}

export function registerUiGalleryScenarios(): void {
  test.describe("public UI gallery", () => {
    test("shows a searchable index and stable component fixtures", async ({
      page,
    }) => {
      await page.goto("/zh/ui");
      await expect(
        page.getByRole("heading", { name: "UI Components" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Button" }).first(),
      ).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "noindex,nofollow",
      );

      const search = page.getByRole("textbox", {
        name: "Search UI components",
      });
      await search.fill("goal");
      await expect(
        page.getByRole("link", {
          name: "Goal visualization",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page
          .locator('[data-sidebar="menu-button"]')
          .filter({ hasText: "Button" }),
      ).toHaveCount(0);
    });

    test("returns 404 for an unknown component slug", async ({ page }) => {
      const response = await page.goto("/zh/ui/not-a-component");
      expect(response?.status()).toBe(404);
    });

    test("renders button and input canonical states with keyboard focus", async ({
      page,
    }) => {
      const buttonFixture = await openUiFixture(
        page,
        "button",
        "button.variant.default",
      );
      const saveButton = buttonFixture.getByRole("button", { name: "Save" });
      await saveButton.focus();
      await expect(saveButton).toBeFocused();

      const disabledFixture = getUiFixture(page, "button.state.disabled");
      await expect(
        disabledFixture.getByRole("button", { name: "Unavailable" }),
      ).toBeDisabled();

      const inputFixture = await openUiFixture(
        page,
        "input",
        "input.state.invalid",
      );
      await expect(inputFixture.locator("input")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    test("opens and selects a real Select option", async ({ page }) => {
      const fixture = await openUiFixture(
        page,
        "select",
        "select.state.weekly",
      );
      const trigger = fixture.getByRole("combobox", {
        name: "Reporting interval",
      });
      await trigger.click();
      await page.getByRole("option", { name: "Daily" }).click();
      await expect(trigger).toContainText("Daily");
    });

    test("opens and dismisses the Dialog, Popover, Tooltip, and Drawer", async ({
      page,
    }) => {
      const dialogFixture = await openUiFixture(
        page,
        "dialog",
        "dialog.scenario.confirmation",
      );
      await dialogFixture.getByRole("button", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog")).toContainText("Review changes");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const popoverFixture = await openUiFixture(
        page,
        "popover",
        "popover.scenario.preview",
      );
      await popoverFixture
        .getByRole("button", { name: "Open details" })
        .click();
      await expect(page.getByText("Quick details")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByText("Quick details")).toHaveCount(0);

      const tooltipFixture = await openUiFixture(
        page,
        "tooltip",
        "tooltip.scenario.help",
      );
      await tooltipFixture
        .getByRole("button", { name: "What is this?" })
        .focus();
      await expect(page.getByRole("tooltip")).toContainText(
        "short contextual hint",
      );

      const drawerFixture = await openUiFixture(
        page,
        "drawer",
        "drawer.scenario.details",
      );
      await drawerFixture.getByRole("button", { name: "Open drawer" }).click();
      await expect(page.getByRole("dialog")).toContainText("Session details");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("uses Calendar, Switch, dropdown, alert dialog, and Sheet interactions", async ({
      page,
    }) => {
      const calendar = await openUiFixture(
        page,
        "calendar",
        "calendar.state.month",
      );
      await calendar.getByRole("button", { name: /next month/i }).click();
      await expect(calendar).toContainText("October 2025");

      const switchFixture = await openUiFixture(
        page,
        "switch",
        "switch.state.on",
      );
      const notifications = switchFixture.getByRole("switch", {
        name: "Enable notifications",
      });
      await expect(notifications).toHaveAttribute("data-state", "checked");
      await notifications.click();
      await expect(notifications).toHaveAttribute("data-state", "unchecked");

      await openUiFixture(
        page,
        "dropdown-menu",
        "dropdown-menu.scenario.actions",
      );
      await page.getByRole("menuitem", { name: "Export CSV" }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);

      await openUiFixture(
        page,
        "alert-dialog",
        "alert-dialog.scenario.confirmation",
      );
      await expect(page.getByRole("alertdialog")).toContainText(
        "Remove saved report?",
      );
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);

      await openUiFixture(page, "sheet", "sheet.scenario.settings");
      await expect(page.getByRole("dialog")).toContainText("Display settings");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("renders production Table, Sidebar, Card, and Goal fixtures", async ({
      page,
    }) => {
      const table = await openUiFixture(
        page,
        "table",
        "table.scenario.analytics",
      );
      await expect(table).toContainText("/pricing");

      const sidebar = await openUiFixture(
        page,
        "sidebar",
        "sidebar.scenario.navigation",
      );
      await expect(
        sidebar.getByRole("button", { name: "Overview" }),
      ).toHaveAttribute("data-active", "true");

      const card = await openUiFixture(page, "card", "card.scenario.metric");
      await expect(card).toContainText("1,284");

      const goal = await openUiFixture(
        page,
        "goal-visualization",
        "goals.goal-visualization.with-comparison",
      );
      await expect(goal).toContainText("+25.0%");
      await expect(goal.getByRole("progressbar")).toHaveCount(2);
    });

    test("renders Funnel and traffic share Product UI fixtures", async ({
      page,
    }) => {
      const funnel = await openUiFixture(page, "funnel", "funnel.state.ready");
      await expect(funnel).toContainText("Viewed pricing");
      await expect(funnel).toContainText("Sessions");
      await expect(funnel).toContainText("Visitors");

      const funnelComparison = await openUiFixture(
        page,
        "funnel",
        "funnel.state.with-comparison",
      );
      await expect(funnelComparison).toContainText("Overall conversion");
      await expect(funnelComparison).toContainText("14%");
      await expect(funnelComparison).toContainText("+16.7%");

      const sharing = await openUiFixture(
        page,
        "sharing",
        "sharing.share-breakdown.with-comparison",
      );
      await expect(sharing).toContainText("Traffic sources");
      await expect(sharing).toContainText("Previous period");
      const searchSegment = sharing
        .getByRole("button", {
          name: /Search/,
        })
        .first();
      await searchSegment.focus();
      await expect(searchSegment).toBeFocused();
    });

    test("renders the realtime traffic Product UI fixture", async ({
      page,
    }) => {
      const realtime = await openUiFixture(
        page,
        "realtime-traffic-trend",
        "realtime-traffic-trend.state.ready",
      );
      await expect(realtime).toContainText("Realtime traffic");
      await expect(realtime).toContainText("Visitors");
      await expect(realtime).toContainText("Views");
      await expect(realtime.locator("[data-slot='chart'] svg")).toBeVisible();
    });

    test("captures representative canonical visual states", async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(async () => document.fonts.ready);

      const fixtures = [
        ["button", "button.variant.default"],
        ["button", "button.variant.outline"],
        ["button", "button.variant.destructive"],
        ["table", "table.scenario.analytics"],
        ["goal-visualization", "goals.goal-visualization.with-comparison"],
        ["funnel", "funnel.state.with-comparison"],
        ["realtime-traffic-trend", "realtime-traffic-trend.state.ready"],
        ["sharing", "sharing.share-breakdown.with-comparison"],
      ] as const;

      for (const [component, fixtureId] of fixtures) {
        const fixture = await openUiFixture(page, component, fixtureId);
        await page.mouse.move(0, 0);
        await expect(fixture).toHaveScreenshot(`${fixtureId}.png`, {
          animations: "disabled",
          caret: "hide",
          maxDiffPixelRatio: 0.02,
        });
      }

      const dialogFixture = await openUiFixture(
        page,
        "dialog",
        "dialog.scenario.confirmation",
      );
      await dialogFixture.getByRole("button", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog")).toHaveScreenshot(
        "dialog.scenario.confirmation.open.png",
        {
          animations: "disabled",
          caret: "hide",
          maxDiffPixelRatio: 0.02,
        },
      );
    });
  });
}
