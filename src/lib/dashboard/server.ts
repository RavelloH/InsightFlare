import "@tanstack/react-start/server-only";

import { cache } from "react";
import { getRequest } from "@tanstack/react-start/server";

import {
  type AdminServiceReadMap,
  readAdminService,
} from "@/lib/edge/admin-service";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import {
  type AccountUserData,
  type SessionTeamGroups,
  type SiteData,
  type TeamData,
} from "@/lib/edge-client-types";
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

function findSiteBySlug(
  sites: SiteWithSlug[],
  siteSlug: string,
): SiteWithSlug | null {
  const bySlug = sites.find((site) => site.slug === siteSlug);
  if (bySlug) return bySlug;
  const byId = sites.find((site) => site.id === siteSlug);
  return byId ?? null;
}

const getMe = cache(async () => {
  try {
    return await readAdmin("session");
  } catch {
    return null;
  }
});

const getAdminRuntime = cache(async () => {
  const runtime = await resolveEdgeRuntime(getRequest());
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
    const runtime = await getAdminRuntime();
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

export const getDashboardProfile = cache(async () => {
  return getMe();
});

export const getDashboardRootContext = cache(
  async (): Promise<DashboardRootContext | null> => {
    const me = await getMe();
    if (!me) return null;

    const notifications = await readAdmin("notifications", { limit: 1 });
    const unreadAttentionCount = notifications?.unreadAttentionCount ?? 0;

    return {
      user: me.user,
      teams: me.teams,
      teamGroups: teamGroupsForProfile(me)!,
      unreadAttentionCount,
    };
  },
);

const getSitesForTeam = cache(
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

export const getDashboardTeamContext = cache(
  async (teamSlug: string): Promise<DashboardTeamContext | null> => {
    const me = await getMe();
    if (!me) return null;

    const activeTeam = me.teams.find((team) => team.slug === teamSlug);
    if (!activeTeam) return null;

    const sites = await getSitesForTeam(activeTeam.id);
    const notifications = await readAdmin("notifications", { limit: 1 });
    const unreadAttentionCount = notifications?.unreadAttentionCount ?? 0;

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

export const getTeamSiteContext = cache(
  async (
    teamSlug: string,
    siteSlug: string,
  ): Promise<DashboardContext | null> => {
    const teamContext = await getDashboardTeamContext(teamSlug);
    if (!teamContext) return null;

    const activeSite = findSiteBySlug(teamContext.sites, siteSlug);
    if (!activeSite) return null;

    return {
      user: teamContext.user,
      teams: teamContext.teams,
      teamGroups: teamContext.teamGroups,
      activeTeam: teamContext.activeTeam,
      sites: teamContext.sites,
      activeSite,
    };
  },
);

export const getDefaultTeamSite = cache(
  async (): Promise<{ teamSlug: string; siteSlug: string } | null> => {
    const me = await getMe();
    if (!me || me.teams.length === 0) return null;

    const firstTeam = me.teams[0];
    const sites = await getSitesForTeam(firstTeam.id);
    if (sites.length === 0) {
      return null;
    }

    return {
      teamSlug: firstTeam.slug,
      siteSlug: sites[0].slug,
    };
  },
);

export const getTeamDefaultSite = cache(
  async (
    teamSlug: string,
  ): Promise<{ teamSlug: string; siteSlug: string } | null> => {
    const me = await getMe();
    if (!me) return null;

    const activeTeam = me.teams.find((team) => team.slug === teamSlug);
    if (!activeTeam) return null;

    const sites = await getSitesForTeam(activeTeam.id);
    if (sites.length === 0) return null;

    return {
      teamSlug: activeTeam.slug,
      siteSlug: sites[0].slug,
    };
  },
);
