import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { loadTeamDashboardSnapshot } from "@/lib/dashboard/route-data";
import { dashboardSiteContext } from "@/lib/dashboard/site-context";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug")({
  beforeLoad: ({ params, context }) => {
    const siteContext = dashboardSiteContext(
      context.teamContext,
      params.siteSlug,
    );
    if (!siteContext) throw notFound();
    return { siteContext };
  },
  loader: ({ context }) => {
    if (typeof window !== "undefined") return { sidebarSnapshot: null };
    const teamId = context.teamContext.activeTeam.id;
    return {
      sidebarSnapshot: {
        teamId,
        window: context.initialDashboardWindow,
        promise: loadTeamDashboardSnapshot({
          data: { teamId, sidebar: true },
        }).catch(() => null),
      },
    };
  },
  head: ({ match }) => ({
    meta: [{ title: match.context.siteContext.activeSite.name }],
  }),
  component: Outlet,
});
