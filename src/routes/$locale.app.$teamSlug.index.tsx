import { createFileRoute } from "@tanstack/react-router";

import { TeamManagementClient } from "@/components/dashboard/admin/team-management-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { resolveReportingTimeZone } from "@/lib/analytics/time-zone";
import { loadTeamDashboardSnapshot } from "@/lib/dashboard/route-data";
import { teamDashboardQueryOptions } from "@/lib/dashboard/team-dashboard-query";
import { browserTimeZone } from "@/lib/dashboard/time-zone";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/")({
  loader: ({ context }) => {
    const { teamContext, initialDashboardWindow } = context;
    const teamId = teamContext.activeTeam.id;
    if (typeof window === "undefined") {
      // The nested promise is streamed by the router. Do not await it here:
      // the authorized site inventory is sufficient to render the shell.
      return {
        snapshot: loadTeamDashboardSnapshot({ data: { teamId } }).catch(
          () => null,
        ),
      };
    }
    // A client navigation does not need HTML streaming. Start the same query
    // before mounting the destination; useQuery will join its in-flight work.
    if (
      initialDashboardWindow.timeZone ===
      resolveReportingTimeZone(teamContext.user.timeZone, browserTimeZone())
    ) {
      void getBrowserQueryClient().prefetchQuery(
        teamDashboardQueryOptions({
          teamId,
          window: initialDashboardWindow,
          range: initialDashboardWindow.preset,
          retainInFlight: true,
        }),
      );
    }
    return { snapshot: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.sites.title,
          match.context,
        ),
      },
    ],
  }),
  component: TeamIndexPage,
});

function TeamIndexPage() {
  const { locale, messages, teamContext, initialDashboardWindow } =
    Route.useRouteContext();
  const { snapshot } = Route.useLoaderData();
  return (
    <TeamManagementClient
      key={JSON.stringify([teamContext.user.id, teamContext.activeTeam.id])}
      locale={locale}
      messages={messages}
      activeTeam={teamContext.activeTeam}
      activeTab="sites"
      systemRole={teamContext.user.systemRole}
      currentUserId={teamContext.user.id}
      authorizedSites={teamContext.sites}
      deferredDashboardSnapshot={
        snapshot
          ? { promise: snapshot, window: initialDashboardWindow }
          : undefined
      }
    />
  );
}
