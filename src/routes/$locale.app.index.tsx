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
import { WorkspaceClient } from "@/components/dashboard/workspace/workspace-client";
import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";

export const Route = createFileRoute("/$locale/app/")({
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
    workspaceSnapshots,
  } = Route.useRouteContext();
  if (dashboardRoot) {
    return (
      <WorkspaceClient
        key={dashboardRoot.user.id}
        locale={locale}
        messages={t}
        dashboard={dashboardRoot}
        snapshots={workspaceSnapshots ?? {}}
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
