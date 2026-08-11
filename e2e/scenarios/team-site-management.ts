import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { createSiteThroughUi, signIn } from "../support/browser";
import type {
  ApiKey,
  CreatedApiKey,
  CreatedTeamInvite,
  E2eContext,
  Member,
  Site,
  TeamInvite,
  User,
} from "../support/flow-context";

export function registerTeamSiteManagementScenarios(context: E2eContext) {
  const { saveManifest, seed } = context;
  const {
    memberA: memberAPassword,
    outsider: outsiderPassword,
    ownerA: ownerAPassword,
    ownerB: ownerBPassword,
    restrictedA: restrictedAPassword,
  } = context.passwords;

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

  test("4. team management pages hydrate, render SSR content, and navigate client-side", async ({
    page,
  }) => {
    const teamA = seed.teams.teamA;
    const siteA = seed.sites.siteA;
    expect(teamA).toBeDefined();
    expect(siteA).toBeDefined();

    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await signIn(page, "owner-a", ownerAPassword);
    await page.goto(`/zh/app/${teamA?.slug}/widgets`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("正在施工中")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute(
      "data-overlayscrollbars-initialize",
    );
    await expect(
      page.locator('link[rel="preload"][as="font"][type="font/woff2"]'),
    ).toHaveCount(1);
    await expect(page.locator("body")).toHaveCSS(
      "font-family",
      /JetBrains Mono Variable/,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.fonts.check('400 16px "JetBrains Mono Variable"'),
        ),
      )
      .toBe(true);

    const publicLinksResponse = await page.request.get(
      `/zh/app/${teamA?.slug}/public-links`,
    );
    expect(publicLinksResponse.status()).toBe(200);
    const publicLinksHtml = await publicLinksResponse.text();
    expect(publicLinksHtml).toContain("公开链接");
    expect(publicLinksHtml).toContain(siteA?.name || "");
    expect(publicLinksHtml).toContain("已启用");

    const transition = page.locator("[data-page-transition]").first();
    await expect(transition).toHaveAttribute(
      "data-page-transition-ready",
      "true",
    );
    await expect(transition).toHaveAttribute("data-transition", "idle");
    const navigation = page.waitForURL(
      new RegExp(`/zh/app/${teamA?.slug}/public-links/?$`),
    );
    await page
      .locator(`a[href="/zh/app/${teamA?.slug}/public-links"]`)
      .first()
      .click();
    await expect(transition).toHaveAttribute("data-transition", "exit");
    await navigation;
    await expect(page.getByText("公开链接").first()).toBeVisible();
    await expect(transition).toHaveAttribute("data-transition", "idle");
    expect(errors).toEqual([]);
  });

  test("5. Team A owner assigns full and site-scoped member access", async ({
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

  test("6. member site access is enforced and cross-team reads are denied", async ({
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

  test("7. team owner creates scoped API keys and members cannot manage them", async ({
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

  test("8. team invites preserve site scope, support registration, and can be revoked", async ({
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

  test("9. public sharing only resolves while the owner enables its slug", async ({
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
}
