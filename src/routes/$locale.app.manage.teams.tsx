import { createFileRoute, notFound } from "@tanstack/react-router";

import { AdminTeamsManagementClient } from "@/components/dashboard/admin-teams-management-client";
import { loadAdminTeamsInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/teams")({
  beforeLoad: async ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
    return { adminTeamsInitialData: await loadAdminTeamsInitialData() };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.adminTeams.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, adminTeamsInitialData } = Route.useRouteContext();
  return (
    <AdminTeamsManagementClient
      locale={locale}
      messages={messages}
      initialData={adminTeamsInitialData}
    />
  );
}
