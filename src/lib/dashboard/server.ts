import "@tanstack/react-start/server-only";

import { getRequest } from "@tanstack/react-start/server";

import { dashboardSiteContext } from "@/lib/dashboard/site-context";
import {
  type AccountUserData,
  type SessionTeamGroups,
  type SiteData,
  type TeamData,
} from "@/lib/dashboard-api/contract/types";
import {
  type AdminServiceReadMap,
  readAdminService,
  readAdminUnreadAttentionCount,
} from "@/lib/edge/admin/service/index";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import {
  enableRequestReadCache,
  memoizeRequestRead,
} from "@/lib/edge/runtime/request-read-cache";
export { buildSitePath } from "@/lib/dashboard/paths";
export interface SiteWithSlug extends SiteData {
  slug: string;
}
export interface DashboardContext {
  user: AccountUserData;
  teams: TeamData[];
  teamGroups: SessionTeamGroups;
  activeTeam: TeamData;
  sites: SiteWithSlug[];
  activeSite: SiteWithSlug;
}
export interface DashboardTeamContext {
  user: AccountUserData;
  teams: TeamData[];
  teamGroups: SessionTeamGroups;
  activeTeam: TeamData;
  sites: SiteWithSlug[];
  unreadAttentionCount: number;
}
export interface DashboardRootContext {
  user: AccountUserData;
  teams: TeamData[];
  teamGroups: SessionTeamGroups;
  unreadAttentionCount: number;
}
function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function getSiteSlug(site: SiteData): string {
  const domain = String(site.domain || "").trim();
  const candidate = safeSlug(domain);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}
function withSiteSlug(site: SiteData): SiteWithSlug {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}
function requestMemo<Args extends string[], T>(
  name: string,
  read: (...args: Args) => Promise<T>,
) {
  return (...args: Args): Promise<T> => {
    const request = getRequest();
    enableRequestReadCache(request);
    return memoizeRequestRead(
      request,
      JSON.stringify(["dashboard", name, ...args]),
      () => read(...args),
    );
  };
}
const getMe = requestMemo("profile", async () => {
  try {
    return await readAdmin("session");
  } catch {
    return null;
  }
});
const getUnreadAttentionCount = requestMemo(
  "unread",
  async (): Promise<number> => {
    try {
      return await readAdminUnreadAttentionCount(await getDashboardRuntime());
    } catch {
      return 0;
    }
  },
);
export const getDashboardRuntime = requestMemo("runtime", async () => {
  const runtime = await resolveEdgeRuntime(getRequest());
  enableRequestReadCache(runtime.request);
  return {
    request: runtime.request,
    env: runtime.env,
    url: runtime.url,
  };
});
async function readAdmin<K extends keyof AdminServiceReadMap>(
  route: K,
  params?: Record<string, string | number>,
): Promise<AdminServiceReadMap[K] | null> {
  try {
    const runtime = await getDashboardRuntime();
    const url = new URL(runtime.url);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const result = await readAdminService({
      route,
      request: runtime.request,
      env: runtime.env,
      url,
    });
    return result;
  } catch {
    return null;
  }
}
/** Server-only typed reads shared by route-level SSR loaders. */
export async function readDashboardAdmin<K extends keyof AdminServiceReadMap>(
  route: K,
  params?: Record<string, string | number>,
): Promise<AdminServiceReadMap[K] | null> {
  return readAdmin(route, params);
}
function teamGroupsForProfile(
  me: Awaited<ReturnType<typeof readAdmin<"session">>>,
) {
  if (!me) return null;
  return (
    me.teamGroups ?? {
      created: [],
      managed: [],
      member: me.teams,
      system: [],
    }
  );
}
export const getDashboardProfile = requestMemo("profile-context", async () => {
  return getMe();
});
export const getDashboardRootContext = requestMemo(
  "root",
  async (): Promise<DashboardRootContext | null> => {
    const [me, unreadAttentionCount] = await Promise.all([
      getMe(),
      getUnreadAttentionCount(),
    ]);
    if (!me) return null;

    return {
      user: me.user,
      teams: me.teams,
      teamGroups: teamGroupsForProfile(me)!,
      unreadAttentionCount,
    };
  },
);
export const getDashboardTeamSites = requestMemo(
  "sites",
  async (teamId: string): Promise<SiteWithSlug[]> => {
    try {
      const sites = await readAdmin("sites", { teamId });
      if (!sites) return [];
      return sites.map(withSiteSlug);
    } catch {
      return [];
    }
  },
);
export const getDashboardTeamContext = requestMemo(
  "team",
  async (teamSlug: string): Promise<DashboardTeamContext | null> => {
    const me = await getMe();
    if (!me) return null;

    const activeTeam = me.teams.find((team) => team.slug === teamSlug);
    if (!activeTeam) return null;

    const [sites, unreadAttentionCount] = await Promise.all([
      getDashboardTeamSites(activeTeam.id),
      getUnreadAttentionCount(),
    ]);

    return {
      user: me.user,
      teams: me.teams,
      teamGroups: teamGroupsForProfile(me)!,
      activeTeam,
      sites,
      unreadAttentionCount,
    };
  },
);
export const getTeamSiteContext = requestMemo(
  "site",
  async (
    teamSlug: string,
    siteSlug: string,
  ): Promise<DashboardContext | null> => {
    const teamContext = await getDashboardTeamContext(teamSlug);
    if (!teamContext) return null;

    return dashboardSiteContext(teamContext, siteSlug);
  },
);

export const getDefaultTeamSite = requestMemo(
  "default",
  async (): Promise<{ teamSlug: string; siteSlug: string } | null> => {
    const me = await getMe();
    if (!me || me.teams.length === 0) return null;

    const firstTeam = me.teams[0];
    const sites = await getDashboardTeamSites(firstTeam.id);
    if (sites.length === 0) {
      return null;
    }

    return {
      teamSlug: firstTeam.slug,
      siteSlug: sites[0].slug,
    };
  },
);
export const getTeamDefaultSite = requestMemo(
  "team-default",
  async (
    teamSlug: string,
  ): Promise<{ teamSlug: string; siteSlug: string } | null> => {
    const me = await getMe();
    if (!me) return null;

    const activeTeam = me.teams.find((team) => team.slug === teamSlug);
    if (!activeTeam) return null;

    const sites = await getDashboardTeamSites(activeTeam.id);
    if (sites.length === 0) return null;

    return {
      teamSlug: activeTeam.slug,
      siteSlug: sites[0].slug,
    };
  },
);
