import { createFileRoute } from "@tanstack/react-router";

import { shareTrendQueryOptions } from "@/components/dashboard/sharing/share-trend-card";
import {
  PagesClientPage,
  pagesListQueryOptions,
} from "@/components/dashboard/site-pages/pages/pages-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import {
  fetchPagesShareTrend,
  PAGE_SHARE_TREND_LIMIT,
  resolvePagesListComparisonQuery,
} from "@/lib/dashboard/client/data/pages";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/pages")({
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
        const { siteId, window, filters, search, comparisonQuery } = input;
        const client = getBrowserQueryClient();
        const list = pagesListQueryOptions({
          siteId,
          window,
          filters,
          comparisonQuery: resolvePagesListComparisonQuery(
            search,
            window,
            filters,
          ),
        });
        if (client.getQueryData(list.queryKey) === undefined)
          void client.prefetchInfiniteQuery(list);
        void client.prefetchQuery(
          shareTrendQueryOptions({
            siteId,
            window,
            filters,
            queryKey: ["pages"],
            fetchTrend: fetchPagesShareTrend,
            limit: PAGE_SHARE_TREND_LIMIT,
            comparisonQuery,
          }),
        );
      }
      return { reads: null };
    }
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
