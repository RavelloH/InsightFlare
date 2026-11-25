import { createFileRoute, notFound } from "@tanstack/react-router";

import { teamManagementQueryOptions } from "@/components/dashboard/admin/team-management/use-team-management";
import { TeamManagementClient } from "@/components/dashboard/admin/team-management-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadTeamManagementInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/settings")({
  beforeLoad: ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
  },
  loader: ({ context }) => {
    const c = context.teamContext;
    if (typeof window === "undefined")
      return {
        deferred: loadTeamManagementInitialData({
          data: { teamId: c.activeTeam.id },
        }).catch(() => null),
      };
    void getBrowserQueryClient().prefetchQuery(
      teamManagementQueryOptions(c.user.id, c.activeTeam.id, true, null, true),
    );
    return { deferred: null };
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
  const { locale, messages, teamContext: c } = Route.useRouteContext();
  const { deferred } = Route.useLoaderData();
  return (
    <TeamManagementClient
      locale={locale}
      messages={messages}
      activeTeam={c.activeTeam}
      activeTab="settings"
      systemRole={c.user.systemRole}
      currentUserId={c.user.id}
      key={JSON.stringify([c.user.id, c.activeTeam.id])}
      authorizedSites={c.sites}
      deferredManagementData={deferred}
    />
  );
}
