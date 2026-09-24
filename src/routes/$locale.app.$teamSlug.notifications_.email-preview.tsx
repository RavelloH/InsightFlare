import { createFileRoute, notFound } from "@tanstack/react-router";

import { NotificationEmailPreviewClient } from "@/components/dashboard/notifications/notification-email-preview-client";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/notifications_/email-preview",
)({
  beforeLoad: ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.notifications.emailPreviewPage
            .title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages } = Route.useRouteContext();
  return <NotificationEmailPreviewClient locale={locale} messages={messages} />;
}
