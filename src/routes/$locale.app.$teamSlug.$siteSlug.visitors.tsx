import { createFileRoute } from "@tanstack/react-router";

import { VisitorsClientPage } from "@/components/dashboard/site-pages/visitors/visitors-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { visitorsListQueryOptions } from "@/lib/dashboard/client/data/visitors";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/visitors",
)({
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
        const { siteId, window, filters } = input;
        const client = getBrowserQueryClient();
        const list = visitorsListQueryOptions({ siteId, window, filters });
        if (client.getQueryData(list.queryKey) === undefined)
          void client.prefetchInfiniteQuery(list);
      }
      return { reads: null };
    }
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
