import { createFileRoute, notFound } from "@tanstack/react-router";

import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadTeamManagementInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/settings")({
  beforeLoad: async ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
    return {
      teamManagementInitialData: await loadTeamManagementInitialData({
        data: { teamId: c.activeTeam.id },
      }),
    };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.settings.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const {
    locale,
    messages,
    teamContext: c,
    teamManagementInitialData,
  } = Route.useRouteContext();
  return (
    <TeamManagementClient
      locale={locale}
      messages={messages}
      activeTeam={c.activeTeam}
      activeTab="settings"
      systemRole={c.user.systemRole}
      currentUserId={c.user.id}
      teamManagementInitialData={teamManagementInitialData}
    />
  );
}
