import { createFileRoute } from "@tanstack/react-router";

import {
  NotificationCenterClient,
  notificationCenterQueryOptions,
} from "@/components/dashboard/notifications/notification-center-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { loadNotificationCenterInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/account/notifications",
)({
  loaderDeps: ({ search }) => ({
    ruleId:
      typeof (search as Record<string, unknown>).ruleId === "string"
        ? ((search as Record<string, unknown>).ruleId as string).trim()
        : "",
  }),
  loader: ({ context, deps }) => {
    const teamId = context.teamContext.activeTeam.id;
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
        context.teamContext.user.id,
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
  const { locale, messages, teamContext: c } = Route.useRouteContext();
  const { deferred, ruleId } = Route.useLoaderData();
  return (
    <NotificationCenterClient
      key={JSON.stringify([c.user.id, c.activeTeam.id])}
      locale={locale}
      messages={messages}
      userId={c.user.id}
      teamId={c.activeTeam.id}
      deferredData={deferred}
      deferredRuleId={ruleId}
    />
  );
}
