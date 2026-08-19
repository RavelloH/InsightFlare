import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAdminMe,
  fetchAdminSites,
  fetchNotificationMessages,
} from "@/lib/edge-client";

const adminServiceMocks = vi.hoisted(() => ({
  getRequest: vi.fn(() => new Request("https://app.test/app")),
  readAdminService:
    vi.fn<(input: { route: string; url: URL }) => Promise<unknown | null>>(),
  resolveEdgeRuntime: vi.fn(),
}));

vi.mock("@/lib/edge-client", () => ({
  fetchAdminMe: vi.fn(),
  fetchAdminSites: vi.fn(),
  fetchNotificationMessages: vi.fn(),
}));

vi.mock("@/lib/edge/admin-service", () => ({
  readAdminService: adminServiceMocks.readAdminService,
}));

vi.mock("@/lib/edge/runtime", () => ({
  resolveEdgeRuntime: adminServiceMocks.resolveEdgeRuntime,
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: adminServiceMocks.getRequest,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  };
});

const fetchAdminMeMock = vi.mocked(fetchAdminMe);
const fetchAdminSitesMock = vi.mocked(fetchAdminSites);
const fetchNotificationMessagesMock = vi.mocked(fetchNotificationMessages);
const readAdminServiceMock = vi.mocked(adminServiceMocks.readAdminService);
const resolveEdgeRuntimeMock = vi.mocked(adminServiceMocks.resolveEdgeRuntime);

async function loadServerModule() {
  vi.resetModules();
  return import("@/lib/dashboard/server");
}

function team(id: string, slug: string) {
  return {
    id,
    name: slug,
    slug,
    ownerUserId: "user-1",
    createdAt: 1,
    siteCount: 1,
    memberCount: 1,
  };
}

function site(
  input: Partial<Awaited<ReturnType<typeof fetchAdminSites>>[number]>,
) {
  return {
    id: "site-1234567890",
    teamId: "team-1",
    name: "Docs Site",
    domain: "docs.example.test",
    publicEnabled: true,
    publicSlug: null,
    createdAt: 1,
    updatedAt: 2,
    ...input,
  };
}

describe("dashboard server helpers", () => {
  beforeEach(() => {
    fetchAdminMeMock.mockReset();
    fetchAdminSitesMock.mockReset();
    fetchNotificationMessagesMock.mockReset();
    fetchNotificationMessagesMock.mockResolvedValue({
      messages: [],
      unreadAttentionCount: 0,
    });
    resolveEdgeRuntimeMock.mockResolvedValue({
      request: new Request("https://app.test/app"),
      env: {},
      url: new URL("https://app.test/app"),
    } as never);
    readAdminServiceMock.mockImplementation((input) => {
      if (input.route === "session") return fetchAdminMeMock() as never;
      if (input.route === "sites") {
        return fetchAdminSitesMock(
          input.url.searchParams.get("teamId") ?? "",
        ) as never;
      }
      if (input.route === "notifications") {
        return fetchNotificationMessagesMock({
          limit: Number(input.url.searchParams.get("limit") ?? 0),
        }) as never;
      }
      return null;
    });
  });

  it("builds stable site slugs from domain or id", async () => {
    const { getSiteSlug, buildSitePath } = await loadServerModule();

    expect(
      getSiteSlug(site({ domain: "xeoos.net", publicSlug: " Public Slug! " })),
    ).toBe("xeoos-net");
    expect(
      getSiteSlug(site({ publicSlug: "", domain: "Docs.EXAMPLE.test" })),
    ).toBe("docs-example-test");
    expect(
      getSiteSlug(site({ id: "abcdef123456", domain: "", name: "My Site" })),
    ).toBe("abcdef12");
    expect(
      getSiteSlug(
        site({
          id: "abcdef123456",
          publicSlug: "",
          domain: "",
          name: "!!!",
        }),
      ),
    ).toBe("abcdef12");
    expect(buildSitePath("zh", "team-a", "site-a")).toBe(
      "/zh/app/team-a/site-a",
    );
    expect(buildSitePath("en", "team-a", "site-a", "events")).toBe(
      "/en/app/team-a/site-a/events",
    );
  });

  it("returns dashboard team and site contexts when data matches slugs", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "admin",
      },
      teams: [team("team-1", "team-a"), team("team-2", "team-b")],
    } as any);
    fetchAdminSitesMock.mockResolvedValue([
      site({ id: "site-1", publicSlug: "Docs" }),
      site({ id: "site-2", publicSlug: "", domain: "blog.example.test" }),
    ]);
    const { getDashboardProfile, getDashboardTeamContext, getTeamSiteContext } =
      await loadServerModule();

    await expect(getDashboardProfile()).resolves.toMatchObject({
      user: { id: "user-1" },
    });

    await expect(getDashboardTeamContext("team-a")).resolves.toMatchObject({
      activeTeam: { id: "team-1" },
      sites: [
        expect.objectContaining({ id: "site-1", slug: "docs-example-test" }),
        expect.objectContaining({ id: "site-2", slug: "blog-example-test" }),
      ],
    });
    await expect(
      getTeamSiteContext("team-a", "docs-example-test"),
    ).resolves.toMatchObject({
      activeSite: { id: "site-1", slug: "docs-example-test" },
    });
    await expect(getTeamSiteContext("team-a", "site-2")).resolves.toMatchObject(
      {
        activeSite: { id: "site-2", slug: "blog-example-test" },
      },
    );
    expect(fetchAdminSitesMock).toHaveBeenCalledWith("team-1");
  });

  it("returns root context and falls back when notification counts fail", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "admin",
        timeZone: "Asia/Shanghai",
      },
      teams: [team("team-1", "team-a")],
      teamGroups: {
        created: [team("team-1", "team-a")],
        managed: [],
        member: [],
        system: [],
      },
    } as any);
    fetchNotificationMessagesMock.mockResolvedValueOnce({
      messages: [],
      unreadAttentionCount: 3,
    });

    const { getDashboardRootContext, getDashboardTeamContext } =
      await loadServerModule();

    await expect(getDashboardRootContext()).resolves.toMatchObject({
      user: { id: "user-1", timeZone: "Asia/Shanghai" },
      teamGroups: {
        created: [expect.objectContaining({ id: "team-1" })],
      },
      unreadAttentionCount: 3,
    });

    fetchNotificationMessagesMock.mockRejectedValueOnce(
      new Error("notifications unavailable"),
    );
    fetchAdminSitesMock.mockResolvedValueOnce([]);
    await expect(getDashboardTeamContext("team-a")).resolves.toMatchObject({
      unreadAttentionCount: 0,
    });
  });

  it("lets system admins resolve teams they do not belong to", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "admin-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "admin",
      },
      teams: [team("team-1", "owned-by-someone-else")],
      teamGroups: {
        created: [],
        managed: [],
        member: [],
        system: [team("team-1", "owned-by-someone-else")],
      },
    } as any);
    fetchAdminSitesMock.mockResolvedValue([]);

    const { getDashboardProfile, getDashboardTeamContext } =
      await loadServerModule();

    await expect(getDashboardProfile()).resolves.toMatchObject({
      teams: [expect.objectContaining({ id: "team-1" })],
    });
    await expect(
      getDashboardTeamContext("owned-by-someone-else"),
    ).resolves.toMatchObject({
      activeTeam: { id: "team-1" },
      user: { id: "admin-1", systemRole: "admin" },
    });
    expect(fetchAdminSitesMock).toHaveBeenCalledWith("team-1");
  });

  it("returns null or empty defaults when profile, team, or sites are missing", async () => {
    fetchAdminMeMock.mockResolvedValueOnce(null as any);
    const { getDashboardRootContext, getDashboardTeamContext } =
      await loadServerModule();
    await expect(getDashboardRootContext()).resolves.toBeNull();
    await expect(getDashboardTeamContext("team-a")).resolves.toBeNull();

    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "admin",
      },
      teams: [],
    } as any);
    const { getDefaultTeamSite: getDefaultWithNoTeams } =
      await loadServerModule();
    await expect(getDefaultWithNoTeams()).resolves.toBeNull();

    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "admin",
      },
      teams: [team("team-1", "team-a")],
    } as any);
    fetchAdminSitesMock.mockResolvedValue([]);
    const { getDefaultTeamSite, getTeamDefaultSite, getTeamSiteContext } =
      await loadServerModule();

    await expect(getDashboardTeamContext("missing")).resolves.toBeNull();
    await expect(getTeamSiteContext("team-a", "missing")).resolves.toBeNull();
    await expect(getDefaultTeamSite()).resolves.toBeNull();
    await expect(getTeamDefaultSite("missing")).resolves.toBeNull();
  });

  it("returns default team/site targets and tolerates fetch failures", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "user",
      },
      teams: [team("team-1", "team-a")],
    } as any);
    fetchAdminSitesMock.mockResolvedValue([site({ publicSlug: "Docs" })]);
    const { getDefaultTeamSite, getTeamDefaultSite } = await loadServerModule();

    await expect(getDefaultTeamSite()).resolves.toEqual({
      teamSlug: "team-a",
      siteSlug: "docs-example-test",
    });
    await expect(getTeamDefaultSite("team-a")).resolves.toEqual({
      teamSlug: "team-a",
      siteSlug: "docs-example-test",
    });

    fetchAdminMeMock.mockRejectedValue(new Error("not signed in"));
    fetchAdminSitesMock.mockRejectedValue(new Error("edge unavailable"));
    const { getDashboardProfile, getDashboardTeamContext } =
      await loadServerModule();

    await expect(getDashboardProfile()).resolves.toBeNull();
    await expect(getDashboardTeamContext("team-a")).resolves.toBeNull();
  });

  it("uses empty site lists when a matching team's sites cannot be loaded", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "user",
      },
      teams: [team("team-1", "team-a")],
    } as any);
    fetchAdminSitesMock.mockRejectedValue(new Error("edge unavailable"));
    const { getDashboardTeamContext, getDefaultTeamSite, getTeamDefaultSite } =
      await loadServerModule();

    await expect(getDashboardTeamContext("team-a")).resolves.toMatchObject({
      activeTeam: { id: "team-1" },
      sites: [],
    });
    await expect(getDefaultTeamSite()).resolves.toBeNull();
    await expect(getTeamDefaultSite("team-a")).resolves.toBeNull();
  });

  it("falls back to zero when root context notifications fail and returns null when teams are unresolvable", async () => {
    fetchAdminMeMock.mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        email: "admin@example.test",
        name: "Admin User",
        systemRole: "user",
      },
      teams: [team("team-1", "team-a")],
    } as any);
    fetchAdminSitesMock.mockResolvedValue([site({ publicSlug: "Docs" })]);
    fetchNotificationMessagesMock.mockRejectedValue(
      new Error("notifications unavailable"),
    );
    const { getDashboardRootContext, getTeamSiteContext } =
      await loadServerModule();

    await expect(getDashboardRootContext()).resolves.toMatchObject({
      unreadAttentionCount: 0,
    });
    await expect(
      getTeamSiteContext("no-such-team", "docs-example-test"),
    ).resolves.toBeNull();
  });

  it("returns null from getTeamDefaultSite when the profile is missing", async () => {
    fetchAdminMeMock.mockResolvedValueOnce(null as any);
    const { getTeamDefaultSite } = await loadServerModule();
    await expect(getTeamDefaultSite("team-a")).resolves.toBeNull();
  });
});
