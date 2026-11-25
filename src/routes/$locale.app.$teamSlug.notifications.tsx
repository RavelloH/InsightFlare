import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiNotification3Line } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import {
  TeamNotificationsClient,
  teamNotificationsQueryOptions,
} from "@/components/dashboard/admin/team-notifications/client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadTeamNotificationsInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/notifications")({
  loader: ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      return { deferred: null };
    const teamId = c.activeTeam.id;
    if (typeof window === "undefined")
      return {
        deferred: loadTeamNotificationsInitialData({ data: { teamId } }).catch(
          () => null,
        ),
      };
    void getBrowserQueryClient().prefetchQuery(
      teamNotificationsQueryOptions(c.user.id, teamId, null, true),
    );
    return { deferred: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.notifications.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, teamContext: c } = Route.useRouteContext();
  const { deferred } = Route.useLoaderData();
  if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiNotification3Line className="size-4" />
            {messages.teamManagement.notifications.forbiddenTitle}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">
            {messages.teamManagement.notifications.forbiddenDescription}
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <TeamNotificationsClient
      key={JSON.stringify([c.user.id, c.activeTeam.id])}
      locale={locale}
      messages={messages}
      teamId={c.activeTeam.id}
      teamSlug={c.activeTeam.slug}
      currentUserId={c.user.id}
      deferredData={deferred}
    />
  );
}
