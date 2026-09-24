import { createFileRoute } from "@tanstack/react-router";

import { CampaignsClientPage } from "@/components/dashboard/site-pages/campaigns/campaigns-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/campaigns",
)({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.campaigns.title,
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
    <CampaignsClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "campaigns",
      )}
    />
  );
}
