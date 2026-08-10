import { expect, type Page } from "@playwright/test";

type ApiEnvelope<T> = {
  data?: T;
  ok?: boolean;
};

export async function signIn(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
  const securityConfig = page.waitForResponse(
    (response) =>
      response.url().includes("/api/public/login-security") &&
      response.request().method() === "GET",
  );
  await page.goto("/zh/login", { waitUntil: "domcontentloaded" });
  expect((await securityConfig).status()).toBe(200);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/public/session") &&
      response.request().method() === "POST",
  );
  await page.locator('button[type="submit"]').click();
  expect((await loginResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/(?:api\/public\/session|zh\/app)\/?$/);
}

export function waitForCollectResponse(
  page: Page,
  expected: { kind: string; pathname: string },
) {
  return page.waitForResponse((response) => {
    if (!response.url().endsWith("/collect")) return false;
    const request = response.request();
    if (request.method() !== "POST") return false;
    try {
      const payload = JSON.parse(request.postData() || "{}") as {
        kind?: string;
        pathname?: string;
      };
      return (
        payload.kind === expected.kind && payload.pathname === expected.pathname
      );
    } catch {
      return false;
    }
  });
}

export async function createSiteThroughUi(
  page: Page,
  input: {
    domain: string;
    name: string;
    publicSlug: string;
    teamSlug: string;
    waitForHydration?: boolean;
  },
): Promise<void> {
  const sitesLoaded = input.waitForHydration
    ? page.waitForResponse(
        (response) =>
          response.url().includes("/api/private/admin/sites") &&
          response.request().method() === "GET",
      )
    : null;
  await page.goto(`/zh/app/${input.teamSlug}/manage/sites`, {
    waitUntil: "domcontentloaded",
  });
  if (sitesLoaded) expect((await sitesLoaded).status()).toBe(200);
  await expect(page.locator("#admin-site-name")).toBeVisible();
  await page.locator("#admin-site-name").fill(input.name);
  await page.locator("#admin-site-domain").fill(input.domain);
  await page.locator("#admin-site-public-slug").fill(input.publicSlug);
  const created = page.waitForResponse(
    (response) =>
      response.url().includes("/api/private/admin/sites") &&
      response.request().method() === "POST",
  );
  await page
    .locator("#admin-site-name")
    .locator("xpath=ancestor::form")
    .locator('button[type="submit"]')
    .click();
  const createResponse = await created;
  expect(createResponse.status()).toBe(200);
  const payload = (await createResponse.json()) as ApiEnvelope<{
    domain: string;
    name: string;
  }>;
  expect(payload).toMatchObject({
    data: { domain: input.domain, name: input.name },
    ok: true,
  });
  const routeSlug = input.domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  await expect(page).toHaveURL(
    new RegExp(`/zh/app/${input.teamSlug}/${routeSlug}/settings$`),
  );
}
