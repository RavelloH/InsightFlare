import { createFileRoute } from "@tanstack/react-router";

import { PagesClientPage } from "@/components/dashboard/site-pages/pages/pages-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/pages")({
  loader: async ({ context, location }) => {
    if (typeof window !== "undefined") return { reads: null };
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "pages",
          siteId: context.siteContext.activeSite.id,
          search: location.searchStr,
        },
      }).catch(() => ({})),
    };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.pages.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, siteContext: c } = Route.useRouteContext();
  const { reads } = Route.useLoaderData();
  return (
    <PagesClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      siteDomain={c.activeSite.domain}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "pages",
      )}
      sitePathname={buildSitePath(locale, c.activeTeam.slug, c.activeSite.slug)}
    />
  );
}
