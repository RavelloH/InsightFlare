import { createFileRoute, notFound } from "@tanstack/react-router";

import { AdminUsersManagementClient } from "@/components/dashboard/admin-users-management-client";
import { loadAdminUsersInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/users")({
  beforeLoad: async ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
    return { adminUsersInitialData: await loadAdminUsersInitialData() };
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
  const { locale, messages, dashboardRoot, adminUsersInitialData } =
    Route.useRouteContext();
  if (!dashboardRoot) throw notFound();
  return (
    <AdminUsersManagementClient
      locale={locale}
      messages={messages}
      currentUserId={dashboardRoot.user.id}
      initialData={adminUsersInitialData}
    />
  );
}
