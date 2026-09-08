import { createFileRoute } from "@tanstack/react-router";

import { GoalsClientPage } from "@/components/dashboard/site-pages/goals-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/goals")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.goals.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});

function Page() {
  const { locale, messages, siteContext: context } = Route.useRouteContext();
  return (
    <GoalsClientPage
      locale={locale}
      messages={messages}
      siteId={context.activeSite.id}
      pathname={buildSitePath(
        locale,
        context.activeTeam.slug,
        context.activeSite.slug,
        "goals",
      )}
      canManage={canManageTeam(
        context.activeTeam.membershipRole,
        context.user.systemRole,
      )}
    />
  );
}
