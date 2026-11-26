import { createFileRoute } from "@tanstack/react-router";

import { VisitorsClientPage } from "@/components/dashboard/site-pages/visitors/visitors-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/visitors",
)({
  loader: async ({ context, location }) => {
    if (typeof window !== "undefined") return { reads: null };
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "visitors",
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
          match.context.messages.visitors.title,
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
    <VisitorsClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "visitors",
      )}
    />
  );
}
