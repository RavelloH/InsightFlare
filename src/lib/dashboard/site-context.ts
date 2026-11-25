import type {
  DashboardContext,
  DashboardTeamContext,
} from "@/lib/dashboard/server";

/** Select only a site from the authorized team read model. */
export function dashboardSiteContext(
  team: DashboardTeamContext,
  siteSlug: string,
): DashboardContext | null {
  const activeSite =
    team.sites.find((site) => site.slug === siteSlug) ??
    team.sites.find((site) => site.id === siteSlug);
  if (!activeSite) return null;
  return {
    user: team.user,
    teams: team.teams,
    teamGroups: team.teamGroups,
    activeTeam: team.activeTeam,
    sites: team.sites,
    activeSite,
  };
}
