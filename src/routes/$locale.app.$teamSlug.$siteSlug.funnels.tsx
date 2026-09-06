import { createFileRoute } from "@tanstack/react-router";

import { FunnelsClientPage } from "@/components/dashboard/site-pages/funnels-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/funnels",
)({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.funnels.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, siteContext: c } = Route.useRouteContext();
  return (
    <FunnelsClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "funnels",
      )}
      canManage={canManageTeam(c.activeTeam.membershipRole, c.user.systemRole)}
    />
  );
}
