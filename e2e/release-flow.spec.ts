import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { type Browser, expect, type Page, test } from "@playwright/test";

import {
  buildHistorySeed,
  type HistorySeedManifest,
} from "../scripts/e2e/seed-history";

const execFileAsync = promisify(execFile);

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Start E2E through scripts/e2e.ts.`);
  }
  return value;
}

type ApiEnvelope<T> = {
  data?: T;
  error?: string;
  message?: string;
  ok?: boolean;
};

type User = {
  email: string;
  id: string;
  name: string;
  systemRole: "admin" | "user";
  username: string;
};

type Team = {
  id: string;
  membershipRole?: "admin" | "member" | "owner";
  name: string;
  ownerUserId: string;
  slug: string;
};

type Site = {
  domain: string;
  id: string;
  name: string;
  publicEnabled: boolean | number;
  publicSlug: string | null;
  teamId: string;
};

type Member = {
  role: "admin" | "member" | "owner";
  siteIds: string[];
  teamId: string;
  userId: string;
  username: string;
};

type ApiKey = {
  id: string;
  name: string;
  scopes: string[];
  siteIds: string[];
  status: "active" | "expired" | "revoked";
  teamId: string;
};

type CreatedApiKey = { key: ApiKey; secret: string };

type TeamInvite = {
  id: string;
  payload: { siteIds?: string[]; teamRole?: "admin" | "member" };
  status: "active" | "revoked" | "used" | "expired";
};

type CreatedTeamInvite = { invite: TeamInvite; url: string };

type NotificationMessage = {
  id: string;
  readAt: number | null;
  ruleId: string;
};

type NotificationRule = {
  enabled: boolean;
  id: string;
  lastCheckedAt: number | null;
};

type NotificationEvaluation = {
  data?: { metrics?: OverviewMetrics };
  status: "checked" | "skipped" | "triggered";
};

type NotificationManualRun = {
  evaluation: NotificationEvaluation;
  messageCount: number;
  summary: { messagesCreated: number };
};

type NotificationEmailConfig = {
  enabled: boolean;
  fromEmail: string;
  resend: { apiKeyHint: string; configured: boolean };
};

type MockEmail = {
  authorization: string;
  body: {
    from?: string;
    html?: string;
    subject?: string;
    text?: string;
    to?: string[];
  };
  id: string;
};

type OverviewMetrics = {
  bounces: number;
  sessions: number;
  views: number;
  visitors: number;
};

type DashboardPage = { pathname: string; sessions: number; views: number };

type EventType = { label: string; views: number };

type DimensionMetric = {
  label: string;
  sessions: number;
  views: number;
  visitors: number;
};

type ReferrerMetric = { referrer: string; sessions: number; views: number };

type PerformancePayload = {
  routes?: Array<{
    metrics: { lcp: { p75: number | null; samples: number } };
    pathname: string;
    views: number;
  }>;
  summaries?: {
    lcp: { avg: number | null; p75: number | null; samples: number };
  };
};

type TrackerExpectation = {
  customEvents: Array<{ eventName: string; pathname: string }>;
  overview: Pick<OverviewMetrics, "views">;
  pageviews: string[];
};

type SeedManifest = {
  apiKeys: Partial<Record<"analyticsRead" | "revoked", CreatedApiKey>>;
  clock: {
    initialNow: string;
    nowMs: number;
    sessionWindowMinutes: number;
    timeZone: string;
  };
  invites: Partial<Record<"active" | "revoked", CreatedTeamInvite>>;
  notifications: Partial<Record<"dailyReport" | "threshold", NotificationRule>>;
  runId: string;
  history?: Partial<Record<"siteB", HistorySeedManifest>>;
  sites: Partial<Record<"siteA" | "siteB" | "siteC", Site>>;
  teams: Partial<Record<"teamA" | "teamB", Team>>;
  tracker?: Partial<Record<"siteA", TrackerExpectation>>;
  users: Partial<
    Record<
      "admin" | "memberA" | "outsider" | "ownerA" | "ownerB" | "restrictedA",
      User
    >
  >;
};

const adminPassword = requiredEnvironmentValue(
  "INSIGHTFLARE_E2E_ADMIN_PASSWORD",
);
const manifestPath = requiredEnvironmentValue("INSIGHTFLARE_E2E_MANIFEST");
const runId = requiredEnvironmentValue("INSIGHTFLARE_E2E_RUN_ID");
const testSiteURL = requiredEnvironmentValue("INSIGHTFLARE_E2E_TEST_SITE_URL");
const controlToken = requiredEnvironmentValue("INSIGHTFLARE_E2E_CONTROL_TOKEN");
const configPath = requiredEnvironmentValue("INSIGHTFLARE_E2E_CONFIG_PATH");
const d1Name = requiredEnvironmentValue("INSIGHTFLARE_E2E_D1_NAME");
const persistencePath = requiredEnvironmentValue(
  "INSIGHTFLARE_E2E_PERSISTENCE_PATH",
);
const e2eNowMs = Number(requiredEnvironmentValue("INSIGHTFLARE_E2E_NOW_MS"));
if (!Number.isFinite(e2eNowMs)) {
  throw new Error("INSIGHTFLARE_E2E_NOW_MS must be a timestamp.");
}
const ownerAPassword = "e2e-owner-a-password";
const ownerBPassword = "e2e-owner-b-password";
const memberAPassword = "e2e-member-a-password";
const restrictedAPassword = "e2e-restricted-a-password";
const outsiderPassword = "e2e-outsider-password";

const seed: SeedManifest = {
  apiKeys: {},
  clock: {
    initialNow: new Date(e2eNowMs).toISOString(),
    nowMs: e2eNowMs,
    sessionWindowMinutes: 30,
    timeZone: "Asia/Shanghai",
  },
  invites: {},
  notifications: {},
  runId,
  users: {
    admin: {
      id: "",
      username: "admin",
      email: "",
      name: "",
      systemRole: "admin",
    },
  },
  teams: {},
  sites: {},
};

async function saveManifest() {
  await writeFile(manifestPath, `${JSON.stringify(seed, null, 2)}\n`);
}

async function signIn(page: Page, username: string, password: string) {
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

async function apiRequest<T>(
  page: Page,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
  cache?: RequestCache,
) {
  return page.evaluate(
    async ({ body, cache, method, path }) => {
      const response = await fetch(path, {
        cache,
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        payload: (await response.json()) as ApiEnvelope<T>,
        status: response.status,
      };
    },
    { body, cache, method, path },
  );
}

async function e2eControlRequest<T>(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  token = controlToken,
) {
  return page.evaluate(
    async ({ body, method, path, token }) => {
      const response = await fetch(`/__e2e__/${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          "x-insightflare-e2e-token": token,
        },
        method,
      });
      return {
        payload: (await response
          .json()
          .catch(() => null)) as ApiEnvelope<T> | null,
        status: response.status,
      };
    },
    { body, method, path, token },
  );
}

async function readMockMailbox(): Promise<MockEmail[]> {
  const response = await fetch(`${testSiteURL}/__e2e__/mailbox`);
  if (!response.ok) {
    throw new Error(`Unable to read E2E mailbox: ${response.status}`);
  }
  const payload = (await response.json()) as { messages?: MockEmail[] };
  return payload.messages ?? [];
}

function siteQueryPath(siteId: string, path: string): string {
  const params = new URLSearchParams({
    from: "0",
    siteId,
    to: String(Date.now()),
  });
  return `/api/private/${path}?${params.toString()}`;
}

function siteQueryPathForWindow(
  siteId: string,
  path: string,
  from: number,
  to: number,
): string {
  const params = new URLSearchParams({
    from: String(from),
    siteId,
    to: String(to),
  });
  return `/api/private/${path}?${params.toString()}`;
}

async function seedHistoricalVisits(
  siteId: string,
): Promise<HistorySeedManifest> {
  const history = buildHistorySeed({
    nowMs: e2eNowMs,
    runId,
    siteId,
  });
  const sqlPath = path.join(path.dirname(manifestPath), "history-seed.sql");
  await writeFile(sqlPath, history.sql);
  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js"),
    "d1",
    "execute",
    d1Name,
    "--config",
    configPath,
    "--file",
    sqlPath,
    "--local",
    "--persist-to",
    persistencePath,
  ]);
  return history.manifest;
}

async function flushSite(page: Page, siteId: string) {
  const flushed = await e2eControlRequest<{ flushed: boolean; siteId: string }>(
    page,
    "POST",
    "ingest/flush",
    { siteId },
  );
  expect(flushed.status).toBe(200);
  expect(flushed.payload?.data).toEqual({ flushed: true, siteId });
}

async function readSiteOverview(page: Page, siteId: string) {
  const overview = await apiRequest<OverviewMetrics>(
    page,
    "GET",
    siteQueryPath(siteId, "overview"),
    undefined,
    "no-store",
  );
  expect(overview.status).toBe(200);
  expect(overview.payload.ok).toBe(true);
  expect(overview.payload.data).toBeDefined();
  return overview.payload.data as OverviewMetrics;
}

function waitForCollectResponse(
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

async function createSiteThroughUi(
  page: Page,
  input: {
    domain: string;
    name: string;
    publicSlug: string;
    teamSlug: string;
    waitForHydration?: boolean;
  },
) {
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
  const payload = (await createResponse.json()) as ApiEnvelope<Site>;
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

test.describe.serial("release E2E flow", () => {
  test("1. bootstrap administrator can authenticate with a real session", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, "admin", adminPassword);

    const session = await apiRequest<{
      user?: User;
    }>(page, "GET", "/api/private/session");
    expect(session.status).toBe(200);
    expect(session.payload.ok).toBe(true);
    expect(session.payload.data?.user).toMatchObject({
      systemRole: "admin",
      username: "admin",
    });
    seed.users.admin = session.payload.data?.user;
    await saveManifest();
  });

  test("2. administrator creates the isolated account and team topology", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, "admin", adminPassword);
    await page.goto("/zh/app/manage/users", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#admin-user-username")).toBeVisible();

    const accounts = [
      {
        key: "ownerA" as const,
        name: "E2E Owner A",
        password: ownerAPassword,
        teamKey: "teamA" as const,
        teamName: "E2E Team A",
        teamSlug: "e2e-team-a",
        username: "owner-a",
      },
      {
        key: "memberA" as const,
        name: "E2E Member A",
        password: memberAPassword,
        teamKey: undefined,
        teamName: "E2E Member A Workspace",
        teamSlug: "e2e-member-a",
        username: "member-a",
      },
      {
        key: "restrictedA" as const,
        name: "E2E Restricted A",
        password: restrictedAPassword,
        teamKey: undefined,
        teamName: "E2E Restricted A Workspace",
        teamSlug: "e2e-restricted-a",
        username: "restricted-a",
      },
      {
        key: "ownerB" as const,
        name: "E2E Owner B",
        password: ownerBPassword,
        teamKey: "teamB" as const,
        teamName: "E2E Team B",
        teamSlug: "e2e-team-b",
        username: "owner-b",
      },
      {
        key: "outsider" as const,
        name: "E2E Outsider",
        password: outsiderPassword,
        teamKey: undefined,
        teamName: "E2E Outsider Workspace",
        teamSlug: "e2e-outsider",
        username: "outsider",
      },
    ];

    for (const account of accounts) {
      const created = await apiRequest<User & { team: Team }>(
        page,
        "POST",
        "/api/private/admin/users",
        {
          email: `${account.username}@example.test`,
          name: account.name,
          password: account.password,
          systemRole: "user",
          teamName: account.teamName,
          teamSlug: account.teamSlug,
          username: account.username,
        },
      );
      expect(created.status).toBe(200);
      expect(created.payload.ok).toBe(true);
      expect(created.payload.data).toMatchObject({
        systemRole: "user",
        username: account.username,
      });
      expect(created.payload.data?.team).toMatchObject({
        name: account.teamName,
        slug: account.teamSlug,
      });
      seed.users[account.key] = created.payload.data;
      if (account.teamKey)
        seed.teams[account.teamKey] = created.payload.data?.team;
    }

    expect(seed.teams.teamA?.ownerUserId).toBe(seed.users.ownerA?.id);
    expect(seed.teams.teamB?.ownerUserId).toBe(seed.users.ownerB?.id);
    await saveManifest();
  });

  test("3. team owners create sites and persist site settings through the UI", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const teamB = seed.teams.teamB;
    expect(teamA).toBeDefined();
    expect(teamB).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    await createSiteThroughUi(page, {
      teamSlug: teamA?.slug || "",
      name: "E2E Site A",
      domain: "e2e-site-a.example.test",
      publicSlug: "e2e-site-a",
      waitForHydration: true,
    });

    const settingsForm = page
      .locator("#site-settings-name")
      .locator("xpath=ancestor::form");
    await page.locator("#site-settings-name").fill("E2E Analytics Site A");
    await page
      .locator("#site-settings-domain")
      .fill("analytics-a.example.test");
    await settingsForm.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(
      new RegExp(`/zh/app/${teamA?.slug}/analytics-a-example-test/settings$`),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#site-settings-name")).toHaveValue(
      "E2E Analytics Site A",
    );
    await expect(page.locator("#site-settings-domain")).toHaveValue(
      "analytics-a.example.test",
    );

    await createSiteThroughUi(page, {
      teamSlug: teamA?.slug || "",
      name: "E2E Site B",
      domain: "e2e-site-b.example.test",
      publicSlug: "e2e-site-b",
      waitForHydration: true,
    });

    const teamASites = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(teamASites.status).toBe(200);
    const persistedSiteA = teamASites.payload.data?.find(
      (site) => site.domain === "analytics-a.example.test",
    );
    expect(persistedSiteA).toMatchObject({
      domain: "analytics-a.example.test",
      name: "E2E Analytics Site A",
      teamId: teamA?.id,
    });
    seed.sites.siteA = persistedSiteA;
    seed.sites.siteB = teamASites.payload.data?.find(
      (site) => site.domain === "e2e-site-b.example.test",
    );
    await saveManifest();

    await signIn(page, "owner-b", ownerBPassword);
    await createSiteThroughUi(page, {
      teamSlug: teamB?.slug || "",
      name: "E2E Site C",
      domain: "e2e-site-c.example.test",
      publicSlug: "e2e-site-c",
      waitForHydration: true,
    });
    const teamBSites = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamB?.id || "")}`,
    );
    expect(teamBSites.status).toBe(200);
    seed.sites.siteC = teamBSites.payload.data?.find(
      (site) => site.domain === "e2e-site-c.example.test",
    );
    expect(seed.sites.siteC).toMatchObject({ teamId: teamB?.id });
    await saveManifest();
  });

  test("4. Team A owner assigns full and site-scoped member access", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    const memberA = seed.users.memberA;
    const restrictedA = seed.users.restrictedA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    expect(memberA).toBeDefined();
    expect(restrictedA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const fullAccess = await apiRequest<Member>(
      page,
      "POST",
      "/api/private/admin/members",
      {
        identifier: memberA?.username || "",
        role: "member",
        siteIds: [],
        teamId: teamA?.id || "",
      },
    );
    expect(fullAccess.status).toBe(200);
    expect(fullAccess.payload.data).toMatchObject({
      role: "member",
      siteIds: [],
      userId: memberA?.id,
    });

    const scopedAccess = await apiRequest<Member>(
      page,
      "POST",
      "/api/private/admin/members",
      {
        identifier: restrictedA?.username || "",
        role: "member",
        siteIds: [siteA?.id || ""],
        teamId: teamA?.id || "",
      },
    );
    expect(scopedAccess.status).toBe(200);
    expect(scopedAccess.payload.data).toMatchObject({
      role: "member",
      siteIds: [siteA?.id],
      userId: restrictedA?.id,
    });

    const members = await apiRequest<Member[]>(
      page,
      "GET",
      `/api/private/admin/members?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(members.status).toBe(200);
    expect(members.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: memberA?.id, siteIds: [] }),
        expect.objectContaining({
          userId: restrictedA?.id,
          siteIds: [siteA?.id],
        }),
      ]),
    );
    await saveManifest();
  });

  test("5. member site access is enforced and cross-team reads are denied", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    const siteB = seed.sites.siteB;
    const teamB = seed.teams.teamB;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    expect(siteB).toBeDefined();
    expect(teamB).toBeDefined();

    await signIn(page, "member-a", memberAPassword);
    const fullMemberSites = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(fullMemberSites.status).toBe(200);
    expect(fullMemberSites.payload.data?.map((site) => site.id).sort()).toEqual(
      [siteA?.id, siteB?.id].sort(),
    );

    await signIn(page, "restricted-a", restrictedAPassword);
    const restrictedSites = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(restrictedSites.status).toBe(200);
    expect(restrictedSites.payload.data?.map((site) => site.id)).toEqual([
      siteA?.id,
    ]);
    const deniedSiteConfig = await apiRequest<unknown>(
      page,
      "GET",
      `/api/private/admin/site-config?siteId=${encodeURIComponent(siteB?.id || "")}`,
    );
    expect(deniedSiteConfig.status).toBe(403);

    await signIn(page, "outsider", outsiderPassword);
    const outsiderTeamRead = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(outsiderTeamRead.status).toBe(403);
    const outsiderOtherTeamRead = await apiRequest<Site[]>(
      page,
      "GET",
      `/api/private/admin/sites?teamId=${encodeURIComponent(teamB?.id || "")}`,
    );
    expect(outsiderOtherTeamRead.status).toBe(403);
  });

  test("6. team owner creates scoped API keys and members cannot manage them", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const analyticsRead = await apiRequest<CreatedApiKey>(
      page,
      "POST",
      "/api/private/admin/api-keys",
      {
        expiresInDays: 30,
        name: "E2E Analytics Site A Read",
        scopes: ["analytics:read"],
        siteIds: [siteA?.id || ""],
        teamId: teamA?.id || "",
      },
    );
    expect(analyticsRead.status).toBe(200);
    expect(analyticsRead.payload.data).toMatchObject({
      key: {
        name: "E2E Analytics Site A Read",
        scopes: ["analytics:read"],
        siteIds: [siteA?.id],
        status: "active",
        teamId: teamA?.id,
      },
    });
    expect(analyticsRead.payload.data?.secret).toMatch(/^ifk_live_/);
    seed.apiKeys.analyticsRead = analyticsRead.payload.data;

    const revocable = await apiRequest<CreatedApiKey>(
      page,
      "POST",
      "/api/private/admin/api-keys",
      {
        expiresInDays: 30,
        name: "E2E Revoked Key",
        scopes: ["site:read"],
        siteIds: [siteA?.id || ""],
        teamId: teamA?.id || "",
      },
    );
    expect(revocable.status).toBe(200);
    const revoked = await apiRequest<ApiKey>(
      page,
      "PATCH",
      "/api/private/admin/api-keys",
      {
        intent: "revoke",
        keyId: revocable.payload.data?.key.id || "",
        teamId: teamA?.id || "",
      },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.payload.data).toMatchObject({
      id: revocable.payload.data?.key.id,
      status: "revoked",
    });
    seed.apiKeys.revoked = revocable.payload.data;

    const listed = await apiRequest<ApiKey[]>(
      page,
      "GET",
      `/api/private/admin/api-keys?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: analyticsRead.payload.data?.key.id }),
        expect.objectContaining({
          id: revocable.payload.data?.key.id,
          status: "revoked",
        }),
      ]),
    );
    expect(JSON.stringify(listed.payload.data)).not.toContain(
      analyticsRead.payload.data?.secret || "",
    );
    await saveManifest();

    await signIn(page, "member-a", memberAPassword);
    const denied = await apiRequest<ApiKey[]>(
      page,
      "GET",
      `/api/private/admin/api-keys?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    expect(denied.status).toBe(403);
  });

  test("7. team invites preserve site scope, support registration, and can be revoked", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const active = await apiRequest<CreatedTeamInvite>(
      page,
      "POST",
      "/api/private/admin/team-invites",
      {
        email: "invitee-a@example.test",
        expiresInHours: 24,
        role: "member",
        siteIds: [siteA?.id || ""],
        teamId: teamA?.id || "",
      },
    );
    expect(active.status).toBe(200);
    expect(active.payload.data).toMatchObject({
      invite: {
        payload: { siteIds: [siteA?.id], teamRole: "member" },
        status: "active",
      },
    });
    seed.invites.active = active.payload.data;
    const token = new URL(
      active.payload.data?.url || "http://invalid/",
    ).hash.replace(/^#token=/, "");
    expect(token).not.toBe("");

    await page.context().clearCookies();
    const inspected = await apiRequest<{ allowsRegistration: boolean }>(
      page,
      "POST",
      "/api/public/account-links/inspect",
      { token },
    );
    expect(inspected.status).toBe(200);
    expect(inspected.payload.data).toMatchObject({ allowsRegistration: true });
    const accepted = await apiRequest<{ user: User }>(
      page,
      "POST",
      "/api/public/account-links/complete",
      {
        email: "invitee-a@example.test",
        name: "E2E Invitee A",
        password: "e2e-invitee-a-password",
        token,
        username: "invitee-a",
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.payload.data?.user).toMatchObject({
      username: "invitee-a",
    });
    const reused = await apiRequest<unknown>(
      page,
      "POST",
      "/api/public/account-links/complete",
      { token },
    );
    expect(reused.status).toBe(400);

    await signIn(page, "owner-a", ownerAPassword);
    const revocable = await apiRequest<CreatedTeamInvite>(
      page,
      "POST",
      "/api/private/admin/team-invites",
      {
        email: "revoked-invite@example.test",
        expiresInHours: 24,
        role: "member",
        siteIds: [],
        teamId: teamA?.id || "",
      },
    );
    expect(revocable.status).toBe(200);
    const revoked = await apiRequest<TeamInvite>(
      page,
      "PATCH",
      "/api/private/admin/team-invites",
      {
        intent: "revoke",
        inviteId: revocable.payload.data?.invite.id || "",
        teamId: teamA?.id || "",
      },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.payload.data).toMatchObject({ status: "revoked" });
    seed.invites.revoked = revocable.payload.data;
    await saveManifest();

    await page.context().clearCookies();
    const revokedToken = new URL(
      revocable.payload.data?.url || "http://invalid/",
    ).hash.replace(/^#token=/, "");
    const revokedInspection = await apiRequest<unknown>(
      page,
      "POST",
      "/api/public/account-links/inspect",
      { token: revokedToken },
    );
    expect(revokedInspection.status).toBe(400);
  });

  test("8. public sharing only resolves while the owner enables its slug", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteA = seed.sites.siteA;
    expect(siteA).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const enabled = await apiRequest<Site>(
      page,
      "PATCH",
      "/api/private/admin/sites",
      {
        publicEnabled: true,
        publicSlug: "e2e-analytics-a",
        siteId: siteA?.id || "",
      },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.payload.data).toMatchObject({
      id: siteA?.id,
      publicEnabled: true,
      publicSlug: "e2e-analytics-a",
    });
    seed.sites.siteA = enabled.payload.data;
    await saveManifest();

    await page.context().clearCookies();
    const publicSite = await apiRequest<{ id: string; name: string }>(
      page,
      "GET",
      "/api/public/share/e2e-analytics-a/site",
      undefined,
      "no-store",
    );
    expect(publicSite.status).toBe(200);
    expect(publicSite.payload.data).toMatchObject({ id: siteA?.id });

    await signIn(page, "owner-a", ownerAPassword);
    const disabled = await apiRequest<Site>(
      page,
      "PATCH",
      "/api/private/admin/sites",
      { publicEnabled: false, siteId: siteA?.id || "" },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.payload.data).toMatchObject({
      id: siteA?.id,
      publicEnabled: false,
      publicSlug: "",
    });
    await page.context().clearCookies();
    const unavailable = await apiRequest<unknown>(
      page,
      "GET",
      "/api/public/share/e2e-analytics-a/site",
      undefined,
      "no-store",
    );
    expect(unavailable.status).toBe(404);
  });

  test("9. real browser tracking reaches the DO and persists pageviews and events", async ({
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

  test("10. realtime websocket receives a visitor before the durable object flush", async ({
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

  test("11. site analytics API and dashboard render the real tracker manifest", async ({
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

    const dashboardOverview = page.waitForResponse(
      (response) =>
        response.url().includes("/api/private/overview") &&
        response.request().method() === "GET",
    );
    await page.goto(`/zh/app/${teamA?.slug}/analytics-a-example-test`, {
      waitUntil: "domcontentloaded",
    });
    const dashboardResponse = await dashboardOverview;
    expect(dashboardResponse.status()).toBe(200);
    const dashboardPayload =
      (await dashboardResponse.json()) as ApiEnvelope<OverviewMetrics>;
    expect(dashboardPayload.data?.views).toBe(expected?.overview.views);
    await expect(
      page.getByText(String(expected?.overview.views), { exact: true }).first(),
    ).toBeVisible();
  });

  test("12. bot and invalid collect requests do not change normal site analytics", async ({
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

    const invalidCollectStatus = await page.evaluate(async (siteId) => {
      const response = await fetch("/collect", {
        body: JSON.stringify({
          collectToken: "not-a-valid-e2e-collect-token",
          hostname: "127.0.0.1",
          kind: "pageview",
          pathname: "/invalid-token",
          siteId,
          timestamp: Date.now(),
          visitId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return response.status;
    }, siteA?.id || "");
    expect(invalidCollectStatus).toBe(204);

    await flushSite(page, siteA?.id || "");
    const after = await readSiteOverview(page, siteA?.id || "");
    expect(after).toEqual(before);
  });

  test("13. historical D1 seed matches analytics query truth", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteB = seed.sites.siteB;
    expect(siteB).toBeDefined();

    const history = await seedHistoricalVisits(siteB?.id || "");
    seed.history = { siteB: history };
    await saveManifest();

    await signIn(page, "owner-a", ownerAPassword);
    const path = (resource: string) =>
      siteQueryPathForWindow(
        siteB?.id || "",
        resource,
        history.fromMs - 1,
        history.toMs + 1,
      );

    const overview = await apiRequest<OverviewMetrics>(
      page,
      "GET",
      path("overview"),
      undefined,
      "no-store",
    );
    expect(overview.status).toBe(200);
    expect(overview.payload.data).toMatchObject({
      sessions: 40,
      views: history.totalVisits,
      visitors: 24,
    });

    const pages = await apiRequest<DashboardPage[]>(
      page,
      "GET",
      path("pages"),
      undefined,
      "no-store",
    );
    expect(pages.status).toBe(200);
    expect(pages.payload.data).toEqual(
      expect.arrayContaining(
        Object.entries(history.pages).map(([pathname, views]) =>
          expect.objectContaining({ pathname, views }),
        ),
      ),
    );

    const referrers = await apiRequest<ReferrerMetric[]>(
      page,
      "GET",
      path("referrers"),
      undefined,
      "no-store",
    );
    expect(referrers.status).toBe(200);
    expect(referrers.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referrer: "google.com",
          sessions: 40,
          views: 40,
        }),
      ]),
    );

    const campaign = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("utm-campaign"),
      undefined,
      "no-store",
    );
    expect(campaign.status).toBe(200);
    expect(campaign.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "summer-launch",
          sessions: 24,
          views: 24,
          visitors: 24,
        }),
      ]),
    );

    const countries = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("countries"),
      undefined,
      "no-store",
    );
    expect(countries.status).toBe(200);
    expect(countries.payload.data).toEqual(
      expect.arrayContaining(
        ["CN", "DE", "JP", "US"].map((label) =>
          expect.objectContaining({ label, views: 30 }),
        ),
      ),
    );

    const devices = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("overview-client-device-type"),
      undefined,
      "no-store",
    );
    expect(devices.status).toBe(200);
    expect(devices.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "desktop", views: 80 }),
        expect.objectContaining({ label: "mobile", views: 40 }),
      ]),
    );

    const browsers = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("overview-client-browser"),
      undefined,
      "no-store",
    );
    expect(browsers.status).toBe(200);
    expect(browsers.payload.data).toEqual(
      expect.arrayContaining(
        ["Chrome", "Edge", "Firefox", "Safari"].map((label) =>
          expect.objectContaining({ label, views: 30 }),
        ),
      ),
    );

    const performance = await apiRequest<unknown>(
      page,
      "GET",
      `${path("performance")}&interval=month`,
      undefined,
      "no-store",
    );
    const performancePayload = performance.payload as ApiEnvelope<unknown> &
      PerformancePayload;
    expect(performance.status).toBe(200);
    expect(performancePayload.summaries?.lcp).toEqual(
      expect.objectContaining({
        avg: 1550,
        p75: 1700,
        samples: 120,
      }),
    );
    expect(performancePayload.routes).toEqual(
      expect.arrayContaining(
        Object.entries(history.pages).map(([pathname, views]) =>
          expect.objectContaining({
            metrics: expect.objectContaining({
              lcp: expect.objectContaining({ samples: views }),
            }),
            pathname,
            views,
          }),
        ),
      ),
    );

    const visitors = await apiRequest<Array<{ visitorId: string }>>(
      page,
      "GET",
      `${path("visitors")}&limit=30`,
      undefined,
      "no-store",
    );
    expect(visitors.status).toBe(200);
    expect(visitors.payload.data).toHaveLength(24);

    const sessions = await apiRequest<Array<{ sessionId: string }>>(
      page,
      "GET",
      `${path("sessions")}&limit=50`,
      undefined,
      "no-store",
    );
    expect(sessions.status).toBe(200);
    expect(sessions.payload.data).toHaveLength(40);
  });

  test("14. scheduled notifications create one persistent message per due rule", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const created = await apiRequest<{ id: string }>(
      page,
      "POST",
      "/api/private/admin/notification-rules",
      {
        condition: {
          metric: "views",
          operator: ">=",
          value: 0,
          window: "last_1h",
        },
        name: "E2E due threshold",
        recipient: { mode: "creator" },
        schedule: { everyMinutes: 30, kind: "interval" },
        siteId: siteA?.id,
        teamId: teamA?.id,
        type: "threshold",
      },
    );
    expect(created.status).toBe(200);
    const ruleId = created.payload.data?.id || "";
    expect(ruleId).not.toBe("");
    seed.notifications.threshold = {
      enabled: true,
      id: ruleId,
      lastCheckedAt: null,
    };
    await saveManifest();
    await e2eControlRequest(page, "POST", "clock/advance", {
      deltaMs: 30 * 60_000,
    });
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run");
    expect(scheduled.status).toBe(200);
    const messages = await apiRequest<{ messages: Array<{ ruleId: string }> }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(ruleId)}`,
    );
    expect(messages.payload.data?.messages).toHaveLength(1);
    expect(messages.payload.data?.messages[0]?.ruleId).toBe(ruleId);
    await e2eControlRequest(page, "POST", "scheduled/run");
    const repeated = await apiRequest<{ messages: Array<{ ruleId: string }> }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(ruleId)}`,
    );
    expect(repeated.payload.data?.messages).toHaveLength(1);
  });

  test("15. notification recipients can mark alerts read and disabled rules stay dormant", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const rule = seed.notifications.threshold;
    expect(teamA).toBeDefined();
    expect(rule).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const beforeRead = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}`,
    );
    expect(beforeRead.status).toBe(200);
    const message = beforeRead.payload.data?.messages[0];
    expect(message).toMatchObject({ readAt: null, ruleId: rule?.id });

    const markedRead = await apiRequest<NotificationMessage>(
      page,
      "PATCH",
      `/api/private/notifications/${encodeURIComponent(message?.id || "")}`,
      {},
    );
    expect(markedRead.status).toBe(200);
    expect(markedRead.payload.data?.readAt).toEqual(expect.any(Number));
    const unread = await apiRequest<{ messages: NotificationMessage[] }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}&unread=1`,
    );
    expect(unread.status).toBe(200);
    expect(unread.payload.data?.messages).toEqual([]);

    const disabled = await apiRequest<NotificationRule>(
      page,
      "PATCH",
      "/api/private/admin/notification-rules",
      { enabled: false, ruleId: rule?.id },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.payload.data?.enabled).toBe(false);
    const lastCheckedAt = disabled.payload.data?.lastCheckedAt;
    await e2eControlRequest(page, "POST", "clock/advance", {
      deltaMs: 30 * 60_000,
    });
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run");
    expect(scheduled.status).toBe(200);

    const rules = await apiRequest<NotificationRule[]>(
      page,
      "GET",
      `/api/private/admin/notification-rules?teamId=${encodeURIComponent(teamA?.id || "")}`,
    );
    const persistedRule = rules.payload.data?.find(
      (item) => item.id === rule?.id,
    );
    expect(persistedRule).toMatchObject({
      enabled: false,
      lastCheckedAt,
    });
    const messages = await apiRequest<{ messages: NotificationMessage[] }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule?.id || "")}`,
    );
    expect(messages.payload.data?.messages).toHaveLength(1);
  });

  test("16. daily report previews, scheduled runs, and manual runs use historical truth", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const siteB = seed.sites.siteB;
    expect(teamA).toBeDefined();
    expect(siteB).toBeDefined();
    await signIn(page, "owner-a", ownerAPassword);
    const created = await apiRequest<NotificationRule>(
      page,
      "POST",
      "/api/private/admin/notification-rules",
      {
        condition: { reportType: "daily" },
        name: "E2E daily report",
        recipient: { mode: "creator" },
        schedule: { kind: "daily", time: "14:00", timezone: "UTC" },
        siteId: siteB?.id,
        teamId: teamA?.id,
        type: "report",
      },
    );
    expect(created.status).toBe(200);
    const rule = created.payload.data;
    expect(rule?.id).toEqual(expect.any(String));
    if (!rule) throw new Error("Daily report rule was not created");
    seed.notifications.dailyReport = rule;
    await saveManifest();

    const preview = await apiRequest<NotificationEvaluation>(
      page,
      "POST",
      "/api/private/admin/notification-rules/preview",
      { ruleId: rule.id },
    );
    expect(preview.status).toBe(200);
    expect(preview.payload.data).toMatchObject({
      data: { metrics: { sessions: 1, views: 1, visitors: 1 } },
      status: "triggered",
    });

    await e2eControlRequest(page, "POST", "clock/advance", {
      deltaMs: 60 * 60_000,
    });
    const scheduled = await e2eControlRequest(page, "POST", "scheduled/run");
    expect(scheduled.status).toBe(200);
    const scheduledMessages = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule.id)}`,
    );
    expect(scheduledMessages.status).toBe(200);
    expect(scheduledMessages.payload.data?.messages).toHaveLength(1);

    const manual = await apiRequest<NotificationManualRun>(
      page,
      "POST",
      "/api/private/admin/notification-rules/run",
      { ruleId: rule.id },
    );
    expect(manual.status).toBe(200);
    expect(manual.payload.data).toMatchObject({
      evaluation: { status: "triggered" },
      messageCount: 1,
      summary: { messagesCreated: 1 },
    });
    const messagesAfterManualRun = await apiRequest<{
      messages: NotificationMessage[];
    }>(
      page,
      "GET",
      `/api/private/notifications?teamId=${encodeURIComponent(teamA?.id || "")}&ruleId=${encodeURIComponent(rule.id)}`,
    );
    expect(messagesAfterManualRun.payload.data?.messages).toHaveLength(2);
  });

  test("17. local Resend mock receives configured test and in-app notification email", async ({
    page,
  }) => {
    const ownerA = seed.users.ownerA;
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(ownerA).toBeDefined();
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();
    await signIn(page, "admin", adminPassword);

    const configured = await apiRequest<NotificationEmailConfig>(
      page,
      "PATCH",
      "/api/private/admin/notification-email",
      {
        enabled: true,
        fromEmail: "notifications@e2e.test",
        fromName: "InsightFlare E2E",
        provider: "resend",
        replyTo: "replies@e2e.test",
        resendApiKey: "e2e-resend-api-key",
      },
    );
    expect(configured.status).toBe(200);
    expect(configured.payload.data).toMatchObject({
      enabled: true,
      fromEmail: "notifications@e2e.test",
      resend: { apiKeyHint: "••••-key", configured: true },
    });

    const testEmail = await apiRequest<{
      messageId: string;
      provider: string;
    }>(page, "POST", "/api/private/admin/notification-email/test", {
      to: ownerA?.email,
    });
    expect(testEmail.status).toBe(200);
    expect(testEmail.payload.data).toMatchObject({
      messageId: "e2e-email-1",
      provider: "resend",
    });

    const mailboxAfterTest = await readMockMailbox();
    expect(mailboxAfterTest).toEqual([
      expect.objectContaining({
        authorization: "Bearer e2e-resend-api-key",
        body: expect.objectContaining({
          from: "InsightFlare E2E <notifications@e2e.test>",
          subject: "InsightFlare email test",
          text: expect.stringContaining("Resend email configuration"),
          to: [ownerA?.email],
        }),
        id: "e2e-email-1",
      }),
    ]);

    const inAppTest = await apiRequest<{
      summary: { emailSent: number; messagesCreated: number };
    }>(page, "POST", "/api/private/admin/notification-test", {
      siteId: siteA?.id,
      teamId: teamA?.id,
      userId: ownerA?.id,
    });
    expect(inAppTest.status).toBe(200);
    expect(inAppTest.payload.data?.summary).toMatchObject({
      emailSent: 1,
      messagesCreated: 1,
    });
    const mailboxAfterNotification = await readMockMailbox();
    expect(mailboxAfterNotification).toHaveLength(2);
    expect(mailboxAfterNotification[1]).toMatchObject({
      body: expect.objectContaining({
        html: expect.stringContaining("InsightFlare notification test"),
        subject: "InsightFlare notification test",
        to: [ownerA?.email],
      }),
      id: "e2e-email-2",
    });
  });

  test("18. E2E clock is token-protected and can expire an existing session", async ({
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
    expect(before.payload?.data?.nowMs).toBe(e2eNowMs + 2 * 60 * 60_000);

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
    const tokenExpiredAt = await e2eControlRequest<{ nowMs: number }>(
      page,
      "POST",
      "clock/advance",
      { deltaMs: 13 * 60 * 60 * 1000 },
    );
    expect(tokenExpiredAt.status).toBe(200);

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

    const advanced = await e2eControlRequest<{ nowMs: number }>(
      page,
      "POST",
      "clock/advance",
      { deltaMs: 31 * 24 * 60 * 60 * 1000 },
    );
    expect(advanced.status).toBe(200);
    expect(advanced.payload?.data?.nowMs).toBe(
      (before.payload?.data?.nowMs || 0) +
        13 * 60 * 60 * 1000 +
        31 * 24 * 60 * 60 * 1000,
    );

    const expired = await apiRequest<unknown>(
      page,
      "GET",
      "/api/private/session",
    );
    expect(expired.status).toBe(401);
  });
});
