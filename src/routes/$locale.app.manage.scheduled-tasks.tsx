import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  ScheduledTasksClient,
  scheduledTasksQueryOptions,
} from "@/components/dashboard/admin/scheduled-tasks-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadScheduledTasksInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/scheduled-tasks")({
  beforeLoad: ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
  },
  loader: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    if (typeof window === "undefined")
      return { deferred: loadScheduledTasksInitialData().catch(() => null) };
    void getBrowserQueryClient().prefetchInfiniteQuery(
      scheduledTasksQueryOptions(
        context.dashboardRoot.user.id,
        "all",
        null,
        true,
      ),
    );
    return { deferred: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.managementNav.scheduledTasks,
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
    <ScheduledTasksClient
      key={dashboardRoot.user.id}
      locale={locale}
      messages={messages}
      userId={dashboardRoot.user.id}
      deferredData={deferred}
    />
  );
}
