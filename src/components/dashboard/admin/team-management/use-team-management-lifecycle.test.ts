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
  fetchTeamMembers: vi.fn(),
  fetchTeamInvites: vi.fn(),
  fetchTeamSites: vi.fn(),
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
  buildSitePath: vi.fn(),
  emptyOverviewMetrics: vi.fn(() => ({ views: 0, sessions: 0 })),
  emptySiteMetricChangeRates: vi.fn(() => ({})),
  fetchTeamInvites: mocks.fetchTeamInvites,
  fetchTeamMembers: mocks.fetchTeamMembers,
  fetchTeamSites: mocks.fetchTeamSites,
  getSiteSlug: vi.fn(),
  postJson: mocks.postJson,
  sortSitesForInitialOrder: vi.fn((sites: unknown[]) => sites),
  withSiteSlug: vi.fn((site: { id: string; domain?: string }) => ({
    ...site,
    slug: site.domain ?? site.id,
  })),
}));

import { useTeamManagement } from "./use-team-management";

type HookResult = ReturnType<typeof useTeamManagement>;
type QueryOptions = {
  queryKey: unknown[];
  queryFn?: (ctx: { signal: AbortSignal }) => Promise<unknown>;
};

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

const teamOne = {
  id: "team-1",
  name: "Team One",
  slug: "team-one",
  membershipRole: "owner",
  ownerUserId: "user-1",
  siteCount: 1,
  memberCount: 1,
};

const baseProps = {
  locale: "en",
  messages: {
    teamManagement: copyProxy(),
    adminSites: copyProxy("adminSites"),
  },
  activeTeam: teamOne,
  activeTab: "members",
  systemRole: "user",
  currentUserId: "user-1",
  teamDashboardSnapshot: null,
  teamManagementInitialData: null,
};

let root: Root | undefined;
let result: HookResult | undefined;
let container: HTMLDivElement;
let hookProps: Record<string, unknown>;
let queryState: {
  data: unknown;
  isPending: boolean;
  refetch: typeof mocks.refetch;
};
let previousClipboard: PropertyDescriptor | undefined;

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

async function rerender(next: Record<string, unknown>) {
  hookProps = { ...hookProps, ...next };
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

function managementOptions(): QueryOptions {
  const call = mocks.useQuery.mock.calls
    .map(([options]) => options as QueryOptions)
    .filter((options) => options.queryKey[1] === "team-management-data")
    .at(-1);
  if (!call) throw new Error("management query was not created");
  return call;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  hookProps = { ...baseProps };
  for (const mock of Object.values(mocks)) mock.mockReset();
  queryState = { data: undefined, isPending: false, refetch: mocks.refetch };
  mocks.useQuery.mockImplementation((options: QueryOptions) =>
    options.queryKey[1] === "team-management-data"
      ? queryState
      : { data: undefined, isPending: false },
  );
  mocks.useDashboardQuery.mockReturnValue({
    window: {
      preset: "last7d",
      from: 1,
      to: 2,
      interval: "day",
      timeZone: "UTC",
    },
  });
  mocks.useRouter.mockReturnValue({ refresh: vi.fn() });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
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

describe("useTeamManagement lifecycle", () => {
  it("loads members, invites and sites together for managers", async () => {
    mocks.fetchTeamMembers.mockResolvedValue(["m"]);
    mocks.fetchTeamInvites.mockResolvedValue(["i"]);
    mocks.fetchTeamSites.mockResolvedValue(["s"]);
    await renderHook();
    const signal = new AbortController().signal;

    const data = (await managementOptions().queryFn!({ signal })) as {
      members: unknown;
      invites: unknown;
      sites: unknown;
      fetchedAt: number;
    };

    expect(mocks.fetchTeamMembers).toHaveBeenCalledWith("team-1", signal);
    expect(mocks.fetchTeamInvites).toHaveBeenCalledWith("team-1", signal);
    expect(mocks.fetchTeamSites).toHaveBeenCalledWith("team-1", signal);
    expect(data).toMatchObject({
      members: ["m"],
      invites: ["i"],
      sites: ["s"],
    });
    expect(typeof data.fetchedAt).toBe("number");
  });

  it("only loads members for non-managers", async () => {
    mocks.fetchTeamMembers.mockResolvedValue(["m"]);
    hookProps = {
      ...baseProps,
      activeTeam: { ...teamOne, membershipRole: "member" },
    };
    await renderHook();

    const data = (await managementOptions().queryFn!({
      signal: new AbortController().signal,
    })) as { members: unknown; invites: unknown; sites: unknown };

    expect(data).toMatchObject({ members: ["m"], invites: [], sites: [] });
    expect(mocks.fetchTeamInvites).not.toHaveBeenCalled();
    expect(mocks.fetchTeamSites).not.toHaveBeenCalled();
  });

  it("keeps the loading flag and previous lists while the management query is pending", async () => {
    queryState.isPending = true;
    hookProps = { ...baseProps, activeTab: "settings" };
    await renderHook();

    expect(result!.isPageDataLoading).toBe(true);
    expect(result!.members).toEqual([]);

    queryState = {
      ...queryState,
      isPending: false,
      data: {
        members: [{ userId: "m1" }],
        invites: [],
        sites: [{ id: "s1", domain: "s1.example.com" }],
        fetchedAt: 1,
      },
    };
    await rerender({});
    expect(result!.isPageDataLoading).toBe(false);
    expect(result!.members).toEqual([{ userId: "m1" }]);
    expect(result!.sites).toEqual([
      { id: "s1", domain: "s1.example.com", slug: "s1.example.com" },
    ]);
  });

  it("resets team scoped form and list state when the active team changes", async () => {
    queryState.data = {
      members: [{ userId: "m1" }],
      invites: [{ id: "i1" }],
      sites: [{ id: "s1", domain: "s1.example.com" }],
      fetchedAt: 1,
    };
    await renderHook();
    expect(result!.members).toHaveLength(1);
    await update(() => {
      result!.setCreateSiteDialogOpen(true);
      result!.setCreateSiteName("draft");
      result!.setCreateSiteDomain("draft.example.com");
      result!.setCreateSitePublicSlug("draft");
      result!.setCreateSiteError("boom");
      result!.setInviteEmail("a@b.c");
      result!.setInviteRole("admin");
      result!.setInviteSiteIds(["s1"]);
      result!.setInviteExpiresInHours("5");
      result!.setTransferTargetId("m1");
      result!.setTransferDialogOpen(true);
      result!.setEditingSiteIds(["s1"]);
      result!.setSiteAccessDialogMember({ userId: "m1" } as never);
    });
    expect(result!.createSiteName).toBe("draft");

    // Hold the query empty so only the reset effect repopulates state.
    queryState = { ...queryState, data: undefined, isPending: true };
    await rerender({
      activeTeam: { ...teamOne, id: "team-2", name: "Team Two", slug: "two" },
    });

    expect(result!.createSiteDialogOpen).toBe(false);
    expect(result!.createSiteName).toBe("");
    expect(result!.createSiteDomain).toBe("");
    expect(result!.createSitePublicSlug).toBe("");
    expect(result!.createSiteError).toBe("");
    expect(result!.teamName).toBe("Team Two");
    expect(result!.teamSlug).toBe("two");
    expect(result!.currentTeamName).toBe("Team Two");
    expect(result!.inviteEmail).toBe("");
    expect(result!.inviteRole).toBe("member");
    expect(result!.inviteSiteIds).toEqual([]);
    expect(result!.inviteExpiresInHours).toBe("72");
    expect(result!.latestInviteUrl).toBe("");
    expect(result!.sites).toEqual([]);
    expect(result!.members).toEqual([]);
    expect(result!.invites).toEqual([]);
    expect(result!.transferTargetId).toBe("");
    expect(result!.transferDialogOpen).toBe(false);
    expect(result!.siteAccessDialogMember).toBeNull();
    expect(result!.editingSiteIds).toEqual([]);
  });

  it("ignores site creation when the team has no id", async () => {
    hookProps = { ...baseProps, activeTeam: { ...teamOne, id: "" } };
    await renderHook();

    await invoke(result!.handleCreateSite);

    expect(mocks.postJson).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("navigates to the new slug when saving a renamed team slug", async () => {
    mocks.postJson.mockResolvedValue({
      id: "team-1",
      name: "Renamed",
      slug: "renamed",
    });
    await renderHook();
    await update(() => {
      result!.setTeamName("Renamed");
      result!.setTeamSlug("renamed");
    });

    await invoke(result!.handleSaveTeamSettings);

    expect(mocks.postJson).toHaveBeenCalledWith(
      "teams",
      { teamId: "team-1", name: "Renamed", slug: "renamed" },
      "PATCH",
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.anything(),
      "/en/app/renamed",
    );
    expect(result!.currentTeamName).toBe("Renamed");
  });

  it("copies invite links and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderHook();

    // Nothing to copy yet.
    await invoke(result!.handleCopyLatestInviteUrl);
    await invoke(() => result!.handleCopyInviteUrl({ url: "" } as never));
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    mocks.postJson.mockResolvedValue({
      id: "i1",
      url: "https://x.test/invite",
    });
    await invoke(result!.handleCreateInvite);
    expect(result!.latestInviteUrl).toBe("https://x.test/invite");

    await invoke(result!.handleCopyLatestInviteUrl);
    expect(writeText).toHaveBeenCalledWith("https://x.test/invite");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("copy.toasts.inviteCopied");

    writeText.mockRejectedValue(new Error("denied"));
    mocks.toastError.mockClear();
    await invoke(result!.handleCopyLatestInviteUrl);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "copy.toasts.inviteCopyFailed",
    );
  });
});
