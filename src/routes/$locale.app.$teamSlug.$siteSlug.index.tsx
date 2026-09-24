import { createFileRoute } from "@tanstack/react-router";

import { OverviewClientPage } from "@/components/dashboard/site-pages/overview/overview-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.overview.title,
          match.context,
        ),
      },
    ],
  }),
  component: SiteOverviewPage,
});

function SiteOverviewPage() {
  const { locale, messages, siteContext } = Route.useRouteContext();
  return (
    <OverviewClientPage
      locale={locale}
      messages={messages}
      siteId={siteContext.activeSite.id}
      siteDomain={siteContext.activeSite.domain}
      pathname={buildSitePath(
        locale,
        siteContext.activeTeam.slug,
        siteContext.activeSite.slug,
      )}
    />
  );
}
