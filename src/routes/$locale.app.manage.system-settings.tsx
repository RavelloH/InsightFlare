import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageHeading } from "@/components/dashboard/page-heading";
import { BotAnalyticsSettingsClient } from "@/components/dashboard/system-settings/bot-analytics-settings-client";
import { LoginTurnstileSettingsClient } from "@/components/dashboard/system-settings/login-turnstile-settings-client";
import { NotificationEmailSettingsClient } from "@/components/dashboard/system-settings/notification-email-settings-client";
import { loadSystemSettingsInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/system-settings")({
  beforeLoad: async ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
    return {
      systemSettingsInitialData: await loadSystemSettingsInitialData(),
    };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.systemSettings.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, dashboardRoot, systemSettingsInitialData } =
    Route.useRouteContext();
  if (!dashboardRoot) throw notFound();
  return (
    <div className="space-y-4">
      <PageHeading
        title={messages.systemSettings.title}
        subtitle={messages.systemSettings.subtitle}
      />
      <BotAnalyticsSettingsClient
        messages={messages}
        initialData={systemSettingsInitialData}
      />
      <LoginTurnstileSettingsClient
        messages={messages}
        initialData={systemSettingsInitialData}
      />
      <NotificationEmailSettingsClient
        locale={locale}
        messages={messages}
        currentUserEmail={dashboardRoot.user.email}
        showHeading={false}
        initialData={systemSettingsInitialData}
      />
    </div>
  );
}
