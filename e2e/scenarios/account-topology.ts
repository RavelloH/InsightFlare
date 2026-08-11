import { expect, test } from "@playwright/test";

import { apiRequest } from "../support/api";
import { signIn } from "../support/browser";
import { type E2eContext, type Team, type User } from "../support/flow-context";

export function registerAccountTopologyScenarios(context: E2eContext) {
  test("2. administrator creates the isolated account and team topology", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signIn(page, "admin", context.adminPassword);
    await page.goto("/zh/app/manage/users", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#admin-user-username")).toBeVisible();
    const accounts = [
      {
        key: "ownerA" as const,
        name: "E2E Owner A",
        password: context.passwords.ownerA,
        teamKey: "teamA" as const,
        teamName: "E2E Team A",
        teamSlug: "e2e-team-a",
        username: "owner-a",
      },
      {
        key: "memberA" as const,
        name: "E2E Member A",
        password: context.passwords.memberA,
        teamKey: undefined,
        teamName: "E2E Member A Workspace",
        teamSlug: "e2e-member-a",
        username: "member-a",
      },
      {
        key: "restrictedA" as const,
        name: "E2E Restricted A",
        password: context.passwords.restrictedA,
        teamKey: undefined,
        teamName: "E2E Restricted A Workspace",
        teamSlug: "e2e-restricted-a",
        username: "restricted-a",
      },
      {
        key: "ownerB" as const,
        name: "E2E Owner B",
        password: context.passwords.ownerB,
        teamKey: "teamB" as const,
        teamName: "E2E Team B",
        teamSlug: "e2e-team-b",
        username: "owner-b",
      },
      {
        key: "outsider" as const,
        name: "E2E Outsider",
        password: context.passwords.outsider,
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
      context.seed.users[account.key] = created.payload.data;
      if (account.teamKey)
        context.seed.teams[account.teamKey] = created.payload.data?.team;
    }
    expect(context.seed.teams.teamA?.ownerUserId).toBe(
      context.seed.users.ownerA?.id,
    );
    expect(context.seed.teams.teamB?.ownerUserId).toBe(
      context.seed.users.ownerB?.id,
    );
    await context.saveManifest();
  });
}
