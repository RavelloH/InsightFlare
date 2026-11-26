import { createFileRoute } from "@tanstack/react-router";

import { GeoClientPage } from "@/components/dashboard/site-pages/geo/geo-client-page";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/geo")({
  loader: async ({ context, location }) => {
    if (typeof window !== "undefined") return { reads: null };
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "geo",
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
          match.context.messages.geo.title,
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
    <GeoClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
    />
  );
}
