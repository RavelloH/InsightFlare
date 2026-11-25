import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  NotificationCenterClient,
  notificationCenterQueryOptions,
} from "@/components/dashboard/notifications/notification-center-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadNotificationCenterInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/inbox")({
  beforeLoad: ({ context }) => {
    if (!context.dashboardRoot) throw notFound();
  },
  loaderDeps: ({ search }) => ({
    ruleId:
      typeof (search as Record<string, unknown>).ruleId === "string"
        ? ((search as Record<string, unknown>).ruleId as string).trim()
        : "",
  }),
  loader: ({ context, deps }) => {
    if (!context.dashboardRoot) throw notFound();
    const teamId = undefined;
    const ruleId = deps.ruleId;
    if (typeof window === "undefined")
      return {
        deferred: loadNotificationCenterInitialData({
          data: { locale: context.locale, teamId, ruleId },
        }).catch(() => null),
        ruleId,
      };
    void getBrowserQueryClient().prefetchQuery(
      notificationCenterQueryOptions(
        context.dashboardRoot.user.id,
        context.locale,
        teamId,
        ruleId,
        null,
        true,
      ),
    );
    return { deferred: null, ruleId };
  },
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
  const { locale, messages, dashboardRoot } = Route.useRouteContext();
  const { deferred, ruleId } = Route.useLoaderData();
  if (!dashboardRoot) throw notFound();
  return (
    <NotificationCenterClient
      key={dashboardRoot.user.id}
      locale={locale}
      messages={messages}
      userId={dashboardRoot.user.id}
      deferredData={deferred}
      deferredRuleId={ruleId}
    />
  );
}
