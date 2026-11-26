import { createFileRoute } from "@tanstack/react-router";

import { referrerRadarQueryOptions } from "@/components/dashboard/referrers/referrer-performance-radar-card";
import { referrerTrendQueryOptions } from "@/components/dashboard/referrers/referrer-share-trend-card";
import { referrerSummaryQueryOptions } from "@/components/dashboard/site-pages/referrers/referrers-client-page";
import { ReferrersClientPage } from "@/components/dashboard/site-pages/referrers/referrers-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/referrers",
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
        const client = getBrowserQueryClient();
        void client.prefetchQuery(referrerSummaryQueryOptions(input));
        void client.prefetchQuery(referrerTrendQueryOptions(input));
        void client.prefetchQuery(referrerRadarQueryOptions(input));
      }
      return { reads: null };
    }
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "referrers",
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
          match.context.messages.referrers.title,
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
    <ReferrersClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "referrers",
      )}
    />
  );
}
