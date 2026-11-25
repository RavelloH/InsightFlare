import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  AdminUsersManagementClient,
  adminUsersQueryOptions,
} from "@/components/dashboard/admin/admin-users-management-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadAdminUsersInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/users")({
  beforeLoad: ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
  },
  loader: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    if (typeof window === "undefined")
      return { deferred: loadAdminUsersInitialData().catch(() => null) };
    void getBrowserQueryClient().prefetchQuery(
      adminUsersQueryOptions(context.dashboardRoot.user.id, null, true),
    );
    return { deferred: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.adminUsers.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, dashboardRoot } = Route.useRouteContext();
  if (!dashboardRoot) throw notFound();
  const { deferred } = Route.useLoaderData();
  return (
    <AdminUsersManagementClient
      key={dashboardRoot.user.id}
      locale={locale}
      messages={messages}
      userId={dashboardRoot.user.id}
      currentUserId={dashboardRoot.user.id}
      deferredData={deferred}
    />
  );
}
