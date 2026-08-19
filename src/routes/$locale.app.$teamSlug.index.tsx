import { createFileRoute } from "@tanstack/react-router";

import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { loadTeamDashboardSnapshot } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/")({
  beforeLoad: async ({ context }) => ({
    teamDashboardSnapshot: await loadTeamDashboardSnapshot({
      data: { teamId: context.teamContext.activeTeam.id },
    }),
  }),
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.sites.title,
          match.context,
        ),
      },
    ],
  }),
  component: TeamIndexPage,
});

function TeamIndexPage() {
  const { locale, messages, teamContext, teamDashboardSnapshot } =
    Route.useRouteContext();
  return (
    <TeamManagementClient
      locale={locale}
      messages={messages}
      activeTeam={teamContext.activeTeam}
      activeTab="sites"
      systemRole={teamContext.user.systemRole}
      currentUserId={teamContext.user.id}
      teamDashboardSnapshot={teamDashboardSnapshot}
    />
  );
}
