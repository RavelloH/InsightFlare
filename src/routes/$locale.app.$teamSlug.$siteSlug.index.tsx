import { createFileRoute } from "@tanstack/react-router";

import { OverviewClientPage } from "@/components/dashboard/site-pages/overview/overview-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/")({
  loader: async ({ context, location }) => {
    if (typeof window !== "undefined") return { reads: null };
    // Wait only for the authenticated request scope, not any analytics read.
    const reads = await loadSiteAnalyticsStream({
      data: {
        siteId: context.siteContext.activeSite.id,
        search: location.searchStr,
      },
    }).catch(() => ({}));
    return { reads };
  },
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
  const { reads } = Route.useLoaderData();
  return (
    <OverviewClientPage
      deferredReads={reads}
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
