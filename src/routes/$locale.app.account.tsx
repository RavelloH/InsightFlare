import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  accountPreferencesQueryOptions,
  AccountSettingsClient,
} from "@/components/dashboard/admin/account-settings-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadAccountNotificationPreferences } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/account")({
  beforeLoad: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
  },
  loader: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
    if (typeof window === "undefined")
      return {
        deferred: loadAccountNotificationPreferences().catch(() => null),
      };
    void getBrowserQueryClient().prefetchQuery(
      accountPreferencesQueryOptions(context.dashboardRoot.user.id, null, true),
    );
    return { deferred: null };
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
  const { locale, messages, dashboardRoot } = Route.useRouteContext();
  const { deferred } = Route.useLoaderData();
  if (!dashboardRoot) throw notFound();
  return (
    <AccountSettingsClient
      locale={locale}
      messages={messages}
      user={dashboardRoot.user}
      key={dashboardRoot.user.id}
      deferredData={deferred}
    />
  );
}
