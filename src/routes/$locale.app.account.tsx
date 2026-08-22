import { createFileRoute, notFound } from "@tanstack/react-router";

import { AccountSettingsClient } from "@/components/dashboard/account-settings-client";
import { loadAccountNotificationPreferences } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/account")({
  beforeLoad: async ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    return {
      accountNotificationPreferencesInitialData:
        await loadAccountNotificationPreferences(),
    };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.accountSettings.title,
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
    dashboardRoot,
    accountNotificationPreferencesInitialData,
  } = Route.useRouteContext();
  if (!dashboardRoot) throw notFound();
  return (
    <AccountSettingsClient
      locale={locale}
      messages={messages}
      user={dashboardRoot.user}
      initialData={accountNotificationPreferencesInitialData}
    />
  );
}
