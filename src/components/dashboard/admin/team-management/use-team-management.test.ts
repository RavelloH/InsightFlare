import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useDashboardQuery: vi.fn(),
  useRouter: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  navigate: vi.fn(),
  postJson: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/components/dashboard/shell/dashboard-query-provider", () => ({
  useDashboardQuery: mocks.useDashboardQuery,
}));
vi.mock("@/lib/router", () => ({ useRouter: mocks.useRouter }));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("@/lib/page-transition", () => ({
  navigateWithTransition: mocks.navigate,
}));
vi.mock("@/lib/dashboard/team-dashboard-query", () => ({
  buildTeamAggregateTrend: vi.fn(() => undefined),
  buildTeamSiteTrends: vi.fn(() => ({})),
  teamDashboardQueryOptions: vi.fn(() => ({ queryKey: ["dashboard", "team"] })),
}));
vi.mock("./model", () => ({
  buildSitePath: vi.fn(
    (locale: string, team: string, site: string) =>
      `/${locale}/app/${team}/sites/${site}`,
  ),
  emptyOverviewMetrics: vi.fn(() => ({ views: 0, sessions: 0 })),
  emptySiteMetricChangeRates: vi.fn(() => ({})),
  fetchTeamInvites: vi.fn(async () => []),
  fetchTeamMembers: vi.fn(async () => []),
  fetchTeamSites: vi.fn(async () => []),
  getSiteSlug: vi.fn(
    (site: { slug?: string; id: string }) => site.slug ?? site.id,
  ),
  postJson: mocks.postJson,
  sortSitesForInitialOrder: vi.fn((sites: unknown[]) => sites),
  withSiteSlug: vi.fn(
    (site: { id: string; slug?: string; domain?: string }) => ({
      ...site,
      slug: site.slug ?? site.domain ?? site.id,
    }),
  ),
}));

import { useTeamManagement } from "./use-team-management";

type HookResult = ReturnType<typeof useTeamManagement>;

const copyProxy = (prefix = "copy", depth = 0) =>
  new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key !== "string"
          ? prefix
          : depth === 0
            ? copyProxy(`${prefix}.${key}`, 1)
            : `${prefix}.${key}`,
    },
  );

const props = {
  locale: "en",
  messages: {
    teamManagement: copyProxy(),
    adminSites: copyProxy("adminSites"),
  },
  activeTeam: {
    id: "team-1",
    name: "Team One",
    slug: "team-one",
    membershipRole: "owner",
    ownerUserId: "user-1",
    siteCount: 1,
    memberCount: 1,
  },
  activeTab: "members",
  systemRole: "user",
  currentUserId: "user-1",
  teamDashboardSnapshot: null,
  teamManagementInitialData: {
    fetchedAt: 100,
    sites: [{ id: "site-1", name: "Site One", domain: "one.example.com" }],
    members: [{ userId: "member-1", role: "member", siteIds: ["site-1"] }],
    invites: [],
  },
};

let root: Root | undefined;
let result: HookResult | undefined;
let container: HTMLDivElement;
let previousClipboard: PropertyDescriptor | undefined;
let hookProps: unknown;
let dashboardQueryData: unknown;
let dashboardQueryPending: boolean;

function Probe() {
  result = useTeamManagement(hookProps as never);
  return null;
}

async function renderHook() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
  });
}

async function update(action: () => void) {
  await act(async () => action());
}

async function invoke(action: () => Promise<unknown>) {
  await act(async () => {
    await action();
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
  }
  root = undefined;
  result = undefined;
  container?.remove();
  if (previousClipboard) {
    Object.defineProperty(navigator, "clipboard", previousClipboard);
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  hookProps = props;
  dashboardQueryData = undefined;
  dashboardQueryPending = true;
  mocks.useQuery.mockReset();
  mocks.useDashboardQuery.mockReset();
  mocks.useRouter.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.navigate.mockReset();
  mocks.postJson.mockReset();
  mocks.refetch.mockReset();
  const window = {
    preset: "last7d",
    from: 1_790_000_000,
    to: 1_790_604_800,
    interval: "day",
    timeZone: "UTC",
  };
  const router = { refresh: vi.fn() };
  const query = {
    data: props.teamManagementInitialData,
    isPending: false,
    refetch: mocks.refetch,
  };
  mocks.useQuery.mockImplementation((options: { queryKey: unknown[] }) =>
    options.queryKey[1] === "team-management-data"
      ? query
      : { data: dashboardQueryData, isPending: dashboardQueryPending },
  );
  mocks.useDashboardQuery.mockReturnValue({ window });
  mocks.useRouter.mockReturnValue(router);
  mocks.postJson.mockImplementation(async (route: string) => {
    if (route === "sites")
      return { id: "site-new", name: "New Site", domain: "new.example.com" };
    if (route === "teams")
      return { id: "team-1", name: "Updated Team", slug: "team-one" };
    if (route === "team-invites")
      return { id: "invite-1", url: "https://example.com/invite" };
    return {};
  });
});

describe("useTeamManagement", () => {
  it("exposes team state and runs validation, success, failure, and copy actions", async () => {
    await renderHook();
    expect(result!.canManage).toBe(true);
    expect(result!.canAdminister).toBe(true);
    expect(result!.isRealOwner).toBe(true);
    expect(result!.isPageDataLoading).toBe(false);
    expect(result!.memberCount).toBe(1);
    expect(result!.siteCount).toBe(1);

    await update(() => result!.toggleInviteSite("site-1", true));
    await update(() => result!.toggleInviteSite("site-1", true));
    expect(result!.inviteSiteIds).toEqual(["site-1"]);
    await update(() => result!.toggleInviteSite("site-1", false));
    await update(() => result!.toggleEditingSite("site-1", true));
    await update(() => result!.toggleEditingSite("site-1", false));

    await invoke(result!.handleCreateSite);
    expect(mocks.toastError).toHaveBeenCalled();
    await update(() => {
      result!.setCreateSiteName("New site");
      result!.setCreateSiteDomain("new.example.com");
      result!.setCreateSitePublicSlug("new-site");
    });
    await invoke(result!.handleCreateSite);
    expect(mocks.navigate).toHaveBeenCalled();

    await update(() => result!.setTeamName("x"));
    await invoke(result!.handleSaveTeamSettings);
    await update(() => {
      result!.setTeamName("Updated Team");
      result!.setTeamSlug("team-one");
    });
    await invoke(result!.handleSaveTeamSettings);

    await update(() => result!.setInviteEmail("invalid"));
    await invoke(result!.handleCreateInvite);
    await update(() => {
      result!.setInviteEmail("person@example.com");
      result!.setInviteExpiresInHours("0");
    });
    await invoke(result!.handleCreateInvite);
    await update(() => result!.setInviteExpiresInHours("24"));
    await invoke(result!.handleCreateInvite);
    expect(result!.latestInviteUrl).toBe("https://example.com/invite");

    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    await invoke(result!.handleCopyLatestInviteUrl);
    await invoke(() =>
      result!.handleCopyInviteUrl({ url: "https://example.com/one" } as never),
    );
    expect(clipboardWrite).toHaveBeenCalledTimes(2);
    clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    await invoke(() =>
      result!.handleCopyInviteUrl({ url: "https://example.com/two" } as never),
    );
  });

  it("uses matching dashboard snapshots and builds site cards from query data", async () => {
    const dashboardWindow = {
      preset: "last7d",
      from: 1_790_000_000,
      to: 1_790_604_800,
      interval: "day",
      timeZone: "UTC",
    };
    dashboardQueryData = {
      window: dashboardWindow,
      data: {
        sites: [
          { id: "site-empty", name: "Empty", domain: "empty.example.com" },
          {
            id: "site-metrics",
            name: "Metrics",
            domain: "metrics.example.com",
            overview: { views: 5, sessions: 2 },
            changeRates: { views: 0.5 },
          },
        ],
        trend: [{ timestampMs: 1, siteId: "site-metrics" }],
      },
    };
    dashboardQueryPending = false;
    hookProps = {
      ...props,
      activeTab: "sites",
      teamDashboardSnapshot: {
        range: "last7d",
        window: dashboardWindow,
      },
    };

    await renderHook();
    expect(result!.window).toMatchObject({ ...dashboardWindow });
    expect(result!.dashboardSites).toHaveLength(2);
    expect(result!.siteCount).toBe(2);
    expect(result!.memberCount).toBe(1);
    expect(result!.isPageDataLoading).toBe(false);
    expect(result!.panelTitle).toBe("copy.sites.title");
    expect(result!.siteDashboardCards).toMatchObject([
      {
        overview: { views: 0, sessions: 0 },
        pagesPerSession: 0,
        changeRates: {},
        trend: [],
      },
      {
        overview: { views: 5, sessions: 2 },
        pagesPerSession: 2.5,
        changeRates: { views: 0.5 },
        trend: [],
      },
    ]);
  });

  it("handles invite, member, site access, team delete, and owner transfer operations", async () => {
    await renderHook();
    await invoke(() => result!.handleRevokeInvite("invite-1"));
    await invoke(() => result!.handleChangeMemberRole("member-1", "admin"));
    await invoke(result!.handleSaveMemberSiteAccess);
    await update(() => {
      result!.setSiteAccessDialogMember({ userId: "member-1" } as never);
      result!.setEditingSiteIds(["site-1"]);
    });
    await invoke(result!.handleSaveMemberSiteAccess);
    await invoke(() => result!.handleRemoveMember("member-1"));
    await invoke(result!.handleDeleteTeam);

    await invoke(result!.handleTransferOwner);
    await update(() => result!.setTransferTargetId("user-2"));
    await invoke(result!.handleTransferOwner);
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith(expect.anything(), "/en/app");
  });

  it("reports failures from each team-management mutation", async () => {
    await renderHook();
    await update(() => {
      result!.setCreateSiteName("New site");
      result!.setCreateSiteDomain("new.example.com");
      result!.setSiteAccessDialogMember({ userId: "member-1" } as never);
      result!.setTransferTargetId("user-2");
    });

    mocks.postJson.mockRejectedValueOnce("offline");
    await invoke(result!.handleCreateSite);
    mocks.postJson.mockRejectedValueOnce(new Error("team update failed"));
    await invoke(result!.handleSaveTeamSettings);
    mocks.postJson.mockRejectedValueOnce(new Error("invite failed"));
    await invoke(result!.handleCreateInvite);
    mocks.postJson.mockRejectedValueOnce(new Error("revoke failed"));
    await invoke(() => result!.handleRevokeInvite("invite-1"));
    mocks.postJson.mockRejectedValueOnce(new Error("delete failed"));
    await invoke(result!.handleDeleteTeam);
    mocks.postJson.mockRejectedValueOnce(new Error("transfer failed"));
    await invoke(result!.handleTransferOwner);
    mocks.postJson.mockRejectedValueOnce(new Error("role update failed"));
    await invoke(() => result!.handleChangeMemberRole("member-1", "admin"));
    mocks.postJson.mockRejectedValueOnce(new Error("site access failed"));
    await invoke(result!.handleSaveMemberSiteAccess);
    mocks.postJson.mockRejectedValueOnce(new Error("member removal failed"));
    await invoke(() => result!.handleRemoveMember("member-1"));

    expect(mocks.toastError).toHaveBeenCalledTimes(9);
  });

  it("uses error fallbacks when mutations fail without a message", async () => {
    await renderHook();
    await update(() => {
      result!.setCreateSiteName("New site");
      result!.setCreateSiteDomain("new.example.com");
      result!.setTeamName("Updated Team");
      result!.setSiteAccessDialogMember({ userId: "member-1" } as never);
      result!.setTransferTargetId("user-2");
    });

    const actions = [
      () => result!.handleCreateSite(),
      () => result!.handleSaveTeamSettings(),
      () => result!.handleCreateInvite(),
      () => result!.handleRevokeInvite("invite-1"),
      () => result!.handleDeleteTeam(),
      () => result!.handleTransferOwner(),
      () => result!.handleChangeMemberRole("member-1", "admin" as const),
      () => result!.handleSaveMemberSiteAccess(),
      () => result!.handleRemoveMember("member-1"),
    ];

    for (const action of actions) {
      mocks.postJson.mockRejectedValueOnce("offline");
      await invoke(action);
    }
    for (const action of actions) {
      mocks.postJson.mockRejectedValueOnce(new Error(""));
      await invoke(action);
    }

    expect(mocks.toastError).toHaveBeenCalledTimes(18);
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      "copy.toasts.memberRemoveFailed",
    );
  });
});
