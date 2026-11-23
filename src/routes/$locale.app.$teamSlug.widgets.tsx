import { createFileRoute, notFound } from "@tanstack/react-router";

import { WidgetsManager } from "@/components/dashboard/widgets/widgets-manager";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/widgets")({
  beforeLoad: ({ context }) => {
    if (
      !canManageTeam(
        context.teamContext.activeTeam.membershipRole,
        context.teamContext.user.systemRole,
      )
    ) {
      throw notFound();
    }
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.widgets.title,
          match.context,
        ),
      },
    ],
  }),
  component: WidgetsPage,
});

function WidgetsPage() {
  const { locale, teamContext } = Route.useRouteContext();

  return (
    <WidgetsManager
      key={teamContext.activeTeam.id}
      locale={locale}
      teamId={teamContext.activeTeam.id}
      teamName={teamContext.activeTeam.name}
      sites={teamContext.sites.map((site) => ({
        id: site.id,
        name: site.name,
        domain: site.domain,
      }))}
    />
  );
}
