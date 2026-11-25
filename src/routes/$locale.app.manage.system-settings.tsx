import { PageHeading } from "@insightflare/ui/page-heading";
import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  AnalyticsEngineSettingsClient,
  analyticsEngineSettingsQueryOptions,
} from "@/components/dashboard/system-settings/analytics-engine-settings-client";
import {
  LoginTurnstileSettingsClient,
  turnstileSettingsQueryOptions,
} from "@/components/dashboard/system-settings/login-turnstile-settings-client";
import {
  emailSettingsQueryOptions,
  NotificationEmailSettingsClient,
} from "@/components/dashboard/system-settings/notification-email-settings-client";
import {
  retentionSettingsQueryOptions,
  ScheduledTaskRetentionSettingsClient,
} from "@/components/dashboard/system-settings/scheduled-task-retention-settings-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import {
  loadAnalyticsEngineSnapshot,
  loadLoginTurnstileSnapshot,
  loadNotificationEmailSnapshot,
  loadRetentionSnapshot,
} from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/system-settings")({
  beforeLoad: ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
  },
  loader: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    const userId = context.dashboardRoot.user.id;
    if (typeof window === "undefined")
      return {
        analyticsEngine: loadAnalyticsEngineSnapshot().catch(() => null),
        loginTurnstile: loadLoginTurnstileSnapshot().catch(() => null),
        notificationEmail: loadNotificationEmailSnapshot().catch(() => null),
        retention: loadRetentionSnapshot().catch(() => null),
      };
    const queryClient = getBrowserQueryClient();
    void queryClient.prefetchQuery(
      analyticsEngineSettingsQueryOptions(userId, null, true),
    );
    void queryClient.prefetchQuery(
      turnstileSettingsQueryOptions(userId, null, true),
    );
    void queryClient.prefetchQuery(
      emailSettingsQueryOptions(userId, null, true),
    );
    void queryClient.prefetchQuery(
      retentionSettingsQueryOptions(userId, null, true),
    );
    return {
      analyticsEngine: null,
      loginTurnstile: null,
      notificationEmail: null,
      retention: null,
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
  const { locale, messages, dashboardRoot } = Route.useRouteContext();
  const data = Route.useLoaderData();
  if (!dashboardRoot) throw notFound();
  return (
    <div key={dashboardRoot.user.id} className="space-y-4">
      <PageHeading
        title={messages.systemSettings.title}
        subtitle={messages.systemSettings.subtitle}
      />
      <AnalyticsEngineSettingsClient
        messages={messages}
        userId={dashboardRoot.user.id}
        deferredData={data.analyticsEngine}
      />
      <LoginTurnstileSettingsClient
        messages={messages}
        userId={dashboardRoot.user.id}
        deferredData={data.loginTurnstile}
      />
      <NotificationEmailSettingsClient
        locale={locale}
        messages={messages}
        currentUserEmail={dashboardRoot.user.email}
        showHeading={false}
        userId={dashboardRoot.user.id}
        deferredData={data.notificationEmail}
      />
      <ScheduledTaskRetentionSettingsClient
        messages={messages}
        userId={dashboardRoot.user.id}
        deferredData={data.retention}
      />
    </div>
  );
}
