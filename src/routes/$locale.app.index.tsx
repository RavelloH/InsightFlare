import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiLoginBoxLine, RiTeamLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import { LogoutActionButton } from "@/components/auth/logout-action-button";
import {
  WorkspaceClient,
  workspaceInventoryQueryOptions,
} from "@/components/dashboard/workspace/workspace-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { resolveReportingTimeZone } from "@/lib/analytics/time-zone";
import {
  loadTeamDashboardSnapshot,
  loadWorkspaceSiteInventory,
  WORKSPACE_TEAM_LIMIT,
} from "@/lib/dashboard/route-data";
import { teamDashboardQueryOptions } from "@/lib/dashboard/team-dashboard-query";
import { browserTimeZone } from "@/lib/dashboard/time-zone";
import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";

export const Route = createFileRoute("/$locale/app/")({
  loader: ({ context }) => {
    const { dashboardRoot, initialDashboardWindow } = context;
    if (!dashboardRoot) return { snapshots: {}, inventory: null };
    const teamIds = dashboardRoot.teams
      .slice(0, WORKSPACE_TEAM_LIMIT)
      .map((team) => team.id);
    if (typeof window === "undefined") {
      return {
        snapshots: Object.fromEntries(
          teamIds.map((teamId) => [
            teamId,
            loadTeamDashboardSnapshot({ data: { teamId } }).catch(() => null),
          ]),
        ),
        inventory: loadWorkspaceSiteInventory({ data: { teamIds } }).catch(
          () => null,
        ),
      };
    }
    const queryClient = getBrowserQueryClient();
    void queryClient.prefetchQuery(
      workspaceInventoryQueryOptions(dashboardRoot.user.id, teamIds),
    );
    if (
      initialDashboardWindow.timeZone ===
      resolveReportingTimeZone(dashboardRoot.user.timeZone, browserTimeZone())
    ) {
      for (const teamId of teamIds) {
        void queryClient.prefetchQuery(
          teamDashboardQueryOptions({
            teamId,
            window: initialDashboardWindow,
            range: initialDashboardWindow.preset,
            retainInFlight: true,
          }),
        );
      }
    }
    return { snapshots: {}, inventory: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.workspace.title,
          match.context,
        ),
      },
    ],
  }),
  component: AppIndexPage,
});

function AppIndexPage() {
  const {
    locale,
    messages: t,
    dashboardRoot,
    initialDashboardWindow,
  } = Route.useRouteContext();
  const { snapshots, inventory } = Route.useLoaderData();
  if (dashboardRoot) {
    return (
      <WorkspaceClient
        key={dashboardRoot.user.id}
        locale={locale}
        messages={t}
        dashboard={dashboardRoot}
        deferredSnapshots={snapshots}
        deferredWindow={initialDashboardWindow}
        deferredInventory={inventory}
      />
    );
  }

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiTeamLine className="size-4" />
            {t.appName}
          </CardTitle>
          <CardDescription>{t.empty.noTeams}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Button asChild>
            <Link href={`/${locale}/login`}>
              <RiLoginBoxLine data-icon="inline-start" />
              <span>{t.login.title}</span>
            </Link>
          </Button>
          <LogoutActionButton
            locale={locale}
            label={t.actions.logout}
            pendingLabel={t.logoutAction.pending}
            successLabel={t.logoutAction.success}
            failedLabel={t.logoutAction.failed}
          />
        </CardContent>
      </Card>
    </main>
  );
}
