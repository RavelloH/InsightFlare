import { createFileRoute } from "@tanstack/react-router";

import { NotificationCenterClient } from "@/components/dashboard/notification-center-client";
import { loadNotificationCenterInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/account/notifications",
)({
  beforeLoad: ({ context }) =>
    loadNotificationCenterInitialData({
      data: {
        locale: context.locale,
        teamId: context.teamContext.activeTeam.id,
      },
    }).then((notificationCenterInitialData) => ({
      notificationCenterInitialData,
    })),
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.notificationCenter.title,
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
    notificationCenterInitialData,
  } = Route.useRouteContext();
  return (
    <NotificationCenterClient
      locale={locale}
      messages={messages}
      teamId={c.activeTeam.id}
      initialData={notificationCenterInitialData}
    />
  );
}
