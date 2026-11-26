import { createFileRoute } from "@tanstack/react-router";

import { geoAnalyticsQueryOptions } from "@/components/dashboard/site-pages/geo/geo-client-page";
import { GeoClientPage } from "@/components/dashboard/site-pages/geo/geo-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/geo")({
  preloadStaleTime: 0,
  loader: async ({ context, location, preload, cause }) => {
    if (typeof window !== "undefined") {
      const input = analyticsNavigationInput({
        preload,
        cause,
        siteId: context.siteContext.activeSite.id,
        window: context.initialDashboardWindow,
        accountTimeZone: context.siteContext.user.timeZone,
        search: location.searchStr,
      });
      if (input) {
        const client = getBrowserQueryClient();
        const options = geoAnalyticsQueryOptions({
          ...input,
          locationValue: input.search.get("location"),
        });
        void client.prefetchQuery(options.points);
        void client.prefetchQuery(options.stats);
      }
      return { reads: null };
    }
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
