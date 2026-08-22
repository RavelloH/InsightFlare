import { createFileRoute } from "@tanstack/react-router";

import { NotificationCenterClient } from "@/components/dashboard/notification-center-client";
import { loadNotificationCenterInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/inbox")({
  beforeLoad: ({ context }) =>
    loadNotificationCenterInitialData({
      data: { locale: context.locale },
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
  const { locale, messages, notificationCenterInitialData } =
    Route.useRouteContext();
  return (
    <NotificationCenterClient
      locale={locale}
      messages={messages}
      initialData={notificationCenterInitialData}
    />
  );
}
