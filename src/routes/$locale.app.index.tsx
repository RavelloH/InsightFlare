import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import {
  RiArrowRightSLine,
  RiLoginBoxLine,
  RiTeamLine,
} from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import { LogoutActionButton } from "@/components/auth/logout-action-button";
import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";

export const Route = createFileRoute("/$locale/app/")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamEntry.title,
          match.context,
        ),
      },
    ],
  }),
  component: AppIndexPage,
});

function AppIndexPage() {
  const { locale, messages: t, dashboardRoot } = Route.useRouteContext();
  if (dashboardRoot && dashboardRoot.teams.length > 0) {
    return (
      <div className="grid h-[calc(100svh-8rem)] min-h-0 place-items-center overflow-hidden">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiTeamLine className="size-4" />
              {t.teamEntry.title}
            </CardTitle>
            <CardDescription>{t.teamEntry.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 p-4">
            {dashboardRoot.teams.map((team) => (
              <Button
                key={team.id}
                asChild
                variant="outline"
                className="w-full justify-between"
              >
                <Link href={`/${locale}/app/${team.slug}`}>
                  <span className="truncate">{team.name}</span>
                  <RiArrowRightSLine
                    data-icon="inline-end"
                    className="text-muted-foreground"
                  />
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
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
