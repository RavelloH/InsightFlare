import { expect, type Locator, type Page, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import type { E2eContext } from "../support/flow-context";

const FRAME_SELECTOR = "[data-layer-frame]";
const LEGACY_Z_ATTRIBUTE = ["data-dashboard-floating-layer", "-z"].join("");

type LayerSnapshot = {
  frameCount: number;
  frames: Array<{
    id: string | null;
    kind: string | null;
    parentId: string | null;
    state: string | null;
    zIndex: string;
  }>;
  hasLegacyZAttribute: boolean;
};

async function layerSnapshot(page: Page): Promise<LayerSnapshot> {
  return page.evaluate(
    ({ frameSelector, legacyZAttribute }) => ({
      frameCount: document.querySelectorAll(frameSelector).length,
      frames: Array.from(document.querySelectorAll(frameSelector)).map(
        (frame) => ({
          id: frame.getAttribute("data-layer-frame-id"),
          kind: frame.getAttribute("data-layer-frame-kind"),
          parentId: frame.getAttribute("data-layer-frame-parent-id"),
          state: frame.getAttribute("data-layer-frame-state"),
          zIndex: (frame as HTMLElement).style.zIndex,
        }),
      ),
      hasLegacyZAttribute: Boolean(
        document.querySelector(`[${legacyZAttribute}]`),
      ),
    }),
    { frameSelector: FRAME_SELECTOR, legacyZAttribute: LEGACY_Z_ATTRIBUTE },
  );
}

function artifactPath(name: string): string {
  const directory = process.env.INSIGHTFLARE_E2E_ARTIFACTS;
  if (!directory) throw new Error("INSIGHTFLARE_E2E_ARTIFACTS is required.");
  return `${directory}/${name}`;
}

async function expectFrameCount(page: Page, count: number) {
  await expect(page.locator(FRAME_SELECTOR)).toHaveCount(count);
}

async function expectNoApplicationError(page: Page) {
  await expect(page.locator("body")).not.toBeEmpty();
  await expect(page.locator("[data-layer-error-overlay]")).toHaveCount(0);
}

async function clickVisibleSelectOption(
  page: Page,
  trigger: Locator,
  value: string,
) {
  await trigger.click();
  const content = page.locator('[data-slot="select-content"]:visible').last();
  await expect(content).toBeVisible();
  const option = content.locator(`[role="option"][data-value="${value}"]`);
  await expect(option).toBeVisible();
  await option.scrollIntoViewIfNeeded();
  const hitTarget = await option.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      matches: Boolean(hit && (hit === element || element.contains(hit))),
      hit: hit
        ? {
            className: hit.className,
            role: hit.getAttribute("role"),
            tagName: hit.tagName,
            text: hit.textContent,
          }
        : null,
      rect: {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      },
    };
  });
  expect(hitTarget.matches, JSON.stringify(hitTarget)).toBe(true);
  await option.click();
}

async function openFilterAndUseSelect(
  page: Page,
  expectedFrameCount: number,
  fieldValue: string,
  valueText: string,
  artifactPrefix: string,
) {
  await expectFrameCount(page, expectedFrameCount);
  const filterDialog = page.locator('[role="dialog"]:visible').last();
  const selectTriggers = filterDialog.locator('[data-slot="select-trigger"]');
  await expect(selectTriggers).toHaveCount(3);

  await clickVisibleSelectOption(page, selectTriggers.nth(1), fieldValue);
  await clickVisibleSelectOption(page, selectTriggers.nth(2), "eq");

  const unsetValueButton = filterDialog
    .getByRole("button")
    .filter({ hasText: "未设置" })
    .last();
  if ((await unsetValueButton.count()) > 0) {
    await unsetValueButton.click();
    const valueInput = page.locator("input:visible").last();
    await expect(valueInput).toBeVisible();
    await valueInput.fill(valueText);
    await page.locator("body").press("Escape");
  } else {
    const valueInput = filterDialog
      .locator('input:not([type="hidden"])')
      .last();
    await expect(valueInput).toBeVisible();
    await valueInput.fill(valueText);
  }

  await page.screenshot({
    path: artifactPath(`${artifactPrefix}-nested-frame.png`),
  });
  const nestedSnapshot = await layerSnapshot(page);
  expect(nestedSnapshot.hasLegacyZAttribute).toBe(false);
  expect(nestedSnapshot.frames.at(-1)?.zIndex).toBe("0");

  const topFrameId = nestedSnapshot.frames.at(-1)?.id;
  await selectTriggers.nth(2).click();
  const openFloatingContent = page
    .locator('[data-slot="select-content"]:visible')
    .last();
  await expect(openFloatingContent).toBeVisible();
  const floatingFrameId = await openFloatingContent.evaluate((element) =>
    element
      .closest('[data-layer-host="floating"]')
      ?.getAttribute("data-layer-frame-id"),
  );
  expect(floatingFrameId).toBe(topFrameId);
  await page.screenshot({
    path: artifactPath(`${artifactPrefix}-floating-open.png`),
  });
  await page.locator("body").press("Escape");

  await filterDialog.getByRole("button", { name: "应用", exact: true }).click();
  await expectFrameCount(page, expectedFrameCount - 1);
  await page.screenshot({
    path: artifactPath(`${artifactPrefix}-after-close.png`),
  });
}

async function createLayerGoal(
  page: Page,
  siteId: string,
  runId: string,
): Promise<string> {
  const eventName = `e2e_layer_purchase_${runId}`;
  const created = await apiRequest<{ goal: { name: string } }>(
    page,
    "POST",
    `/api/private/goals?siteId=${encodeURIComponent(siteId)}`,
    {
      filterDsl: `event.name eq "${eventName}"`,
      filterDslVersion: 1,
      name: `E2E layer purchase ${runId}`,
    },
  );
  expect(created.status).toBe(201);
  return eventName;
}

async function createLayerFunnel(
  page: Page,
  siteId: string,
  runId: string,
  eventName: string,
): Promise<string> {
  const name = `E2E layer funnel ${runId}`;
  const created = await apiRequest<{ funnel: { name: string } }>(
    page,
    "POST",
    `/api/private/funnels?siteId=${encodeURIComponent(siteId)}`,
    {
      conversionWindowMs: null,
      name,
      progressionScope: "session",
      steps: [
        {
          filterDsl: 'page.path eq "/layer-landing"',
          id: `layer-step-landing-${runId}`,
          name: "Landing",
        },
        {
          filterDsl: `event.name eq "${eventName}"`,
          id: `layer-step-signup-${runId}`,
          name: "Signup",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  expect(created.payload.data?.funnel.name).toBe(name);
  return name;
}

async function openGoalEditor(page: Page, route: string, name: string) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const goal = page.getByRole("button", { name: `打开目标: ${name}` });
  await expect(goal).toBeVisible();
  await goal.click();
  await expect(
    page.locator(`${FRAME_SELECTOR}[data-layer-frame-kind="detail-drawer"]`),
  ).toHaveCount(1);
  await page.screenshot({ path: artifactPath("goal-before.png") });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
}

async function openFunnelEditor(page: Page, route: string, name: string) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const funnel = page.getByRole("button", { name: `打开漏斗: ${name}` });
  await expect(funnel).toBeVisible();
  await funnel.click();
  await expect(
    page.locator(`${FRAME_SELECTOR}[data-layer-frame-kind="detail-drawer"]`),
  ).toHaveCount(1);
  await page.screenshot({ path: artifactPath("funnel-before.png") });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
}

async function runGoalFlow(
  page: Page,
  route: string,
  name: string,
  mobile: boolean,
) {
  await openGoalEditor(page, route, name);
  const editor = page.locator('[role="dialog"]:visible').last();
  await editor.getByRole("button", { name: /转化条件/ }).click();
  await openFilterAndUseSelect(
    page,
    2,
    "page.path",
    "/layer-system",
    mobile ? "goal-mobile" : "goal",
  );
  await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
}

async function runFunnelFlow(
  page: Page,
  route: string,
  name: string,
  eventName: string,
  mobile: boolean,
) {
  await openFunnelEditor(page, route, name);
  const editor = page.locator('[role="dialog"]:visible').last();
  await editor.getByRole("button", { name: /筛选/ }).first().click();
  await openFilterAndUseSelect(
    page,
    2,
    "event.name",
    eventName,
    mobile ? "funnel-mobile" : "funnel",
  );
  await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
}

async function runStressFixture(page: Page, route: string) {
  await page.goto(`${route}?__layerFixture=stress`, {
    waitUntil: "domcontentloaded",
  });
  await expectFrameCount(page, 5);
  const initial = await layerSnapshot(page);
  expect(initial.frames.map((frame) => frame.kind)).toEqual(
    Array.from({ length: 5 }, () => "detail-drawer"),
  );
  expect(
    initial.frames.slice(1).every((frame) => Boolean(frame.parentId)),
  ).toBe(true);
  await page.screenshot({ path: artifactPath("detail-before.png") });

  await page.getByRole("button", { name: "Open stress dialog" }).click();
  await expectFrameCount(page, 6);
  await page.getByRole("button", { name: "Open stress filter dialog" }).click();
  await expectFrameCount(page, 7);
  await page.screenshot({ path: artifactPath("detail-nested-frame.png") });

  const selectTrigger = page.getByRole("combobox", {
    name: "Stress filter select",
  });
  await selectTrigger.click();
  const option = page.getByRole("option", { name: "Second filter value" });
  await expect(option).toBeVisible();
  const hitTarget = await option.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
  expect(hitTarget).toBe(true);
  const stressSnapshot = await layerSnapshot(page);
  const topFrameId = stressSnapshot.frames.at(-1)?.id;
  expect(
    await option.evaluate((element) =>
      element
        .closest('[data-layer-host="floating"]')
        ?.getAttribute("data-layer-frame-id"),
    ),
  ).toBe(topFrameId);
  await page.screenshot({ path: artifactPath("detail-floating-open.png") });
  await page.keyboard.press("Escape");
  await expectFrameCount(page, 7);
  await selectTrigger.click();
  await expect(
    page.getByRole("option", { name: "Second filter value" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Second filter value" }).click();
  await expectFrameCount(page, 7);
  await page.keyboard.press("Escape");
  await expectFrameCount(page, 6);
  await page.keyboard.press("Escape");
  await expectFrameCount(page, 5);
  for (let expected = 4; expected >= 0; expected -= 1) {
    await page.keyboard.press("Escape");
    await expectFrameCount(page, expected);
  }
  await page.screenshot({ path: artifactPath("detail-after-close.png") });
}

async function runDetailBackdropDismissal(page: Page, route: string) {
  await page.goto(`${route}?__layerFixture=stress`, {
    waitUntil: "domcontentloaded",
  });
  await expectFrameCount(page, 5);

  const backdropHitTarget = await page.evaluate(() => {
    const hit = document.elementFromPoint(8, 8);
    return hit
      ? {
          dataDetailDrawerRoot: hit.hasAttribute("data-detail-drawer-root"),
          dataSlot: hit.getAttribute("data-slot"),
        }
      : null;
  });
  expect(backdropHitTarget).toEqual({
    dataDetailDrawerRoot: false,
    dataSlot: "app-overlay",
  });

  await page.mouse.click(8, 8);
  await expectFrameCount(page, 4);
}

async function runNestedEventDrawerBackdrop(page: Page, route: string) {
  await page.goto(`${route}?__layerFixture=stress`, {
    waitUntil: "domcontentloaded",
  });
  await expectFrameCount(page, 5);

  await page.getByRole("button", { name: "Open stress event drawer" }).click();
  await expectFrameCount(page, 6);

  const eventDrawerFrame = page.locator(
    `${FRAME_SELECTOR}[data-layer-frame-kind="drawer"]`,
  );
  const eventDrawerOverlay = eventDrawerFrame.locator(
    '[data-layer-host="backdrop"] [data-slot="app-overlay"]',
  );
  await expect(eventDrawerOverlay).toBeVisible();
  await page.mouse.click(8, 8);
  await expectFrameCount(page, 5);
}

async function runSyntheticFixture(page: Page, route: string) {
  await page.goto(`${route}?__layerFixture=synthetic`, {
    waitUntil: "domcontentloaded",
  });
  await expectFrameCount(page, 20);
  const snapshot = await layerSnapshot(page);
  expect(snapshot.frames.map((frame) => frame.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => `e2e-synthetic-layer-${index}`),
  );
  expect(snapshot.frames.every((frame) => frame.kind === "command")).toBe(true);
  expect(snapshot.frames.every((frame) => frame.zIndex === "0")).toBe(true);
  expect(snapshot.frames.every((frame) => frame.parentId === "")).toBe(true);
  expect(snapshot.hasLegacyZAttribute).toBe(false);
  await page.screenshot({ path: artifactPath("synthetic-20.png") });
}

export function registerLayerSystemScenarios(context: E2eContext) {
  test("layer system keeps real overlays in DOM order and interaction order", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource:")
      ) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const team = context.seed.teams.teamA;
    const site = context.seed.sites.siteA;
    expect(team).toBeDefined();
    expect(site).toBeDefined();

    await signIn(page, "owner-a", context.passwords.ownerA);
    const eventName = await createLayerGoal(
      page,
      site?.id || "",
      context.runId,
    );
    const funnelName = await createLayerFunnel(
      page,
      site?.id || "",
      context.runId,
      eventName,
    );

    await signIn(page, "admin", context.adminPassword);
    const base = `/zh/app/${team?.slug}/analytics-a-example-test`;
    const goalRoute = `${base}/goals`;
    const funnelRoute = `${base}/funnels`;
    const goalName = `E2E layer purchase ${context.runId}`;

    await page.setViewportSize({ width: 1280, height: 900 });
    await runGoalFlow(page, goalRoute, goalName, false);
    await expectNoApplicationError(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await runGoalFlow(page, goalRoute, goalName, true);
    await expectNoApplicationError(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await runFunnelFlow(page, funnelRoute, funnelName, eventName, false);
    await expectNoApplicationError(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await runFunnelFlow(page, funnelRoute, funnelName, eventName, true);
    await expectNoApplicationError(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await runDetailBackdropDismissal(page, goalRoute);
    await runNestedEventDrawerBackdrop(page, goalRoute);
    await runStressFixture(page, goalRoute);
    await runSyntheticFixture(page, goalRoute);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
