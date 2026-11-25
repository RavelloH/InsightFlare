import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  AdminTeamsManagementClient,
  adminTeamsQueryOptions,
} from "@/components/dashboard/admin/admin-teams-management-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadAdminTeamsInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/teams")({
  beforeLoad: ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
  },
  loader: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    if (typeof window === "undefined")
      return { deferred: loadAdminTeamsInitialData().catch(() => null) };
    void getBrowserQueryClient().prefetchQuery(
      adminTeamsQueryOptions(context.dashboardRoot.user.id, null, true),
    );
    return { deferred: null };
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
  const { locale, messages, dashboardRoot } = Route.useRouteContext();
  const { deferred } = Route.useLoaderData();
  if (!dashboardRoot) throw notFound();
  return (
    <AdminTeamsManagementClient
      key={dashboardRoot.user.id}
      locale={locale}
      messages={messages}
      userId={dashboardRoot.user.id}
      deferredData={deferred}
    />
  );
}
