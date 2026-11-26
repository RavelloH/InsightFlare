import { createFileRoute } from "@tanstack/react-router";

import { shareTrendQueryOptions } from "@/components/dashboard/sharing/share-trend-card";
import { CampaignsClientPage } from "@/components/dashboard/site-pages/campaigns/campaigns-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import {
  CAMPAIGN_TREND_LIMIT,
  fetchUtmTrend,
} from "@/lib/dashboard/client/data/referrers";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/campaigns",
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
        for (const tab of [
          "source",
          "medium",
          "campaign",
          "term",
          "content",
        ] as const) {
          void client.prefetchQuery(
            shareTrendQueryOptions({
              ...input,
              queryKey: ["campaign", tab],
              limit: CAMPAIGN_TREND_LIMIT,
              fetchTrend: (siteId, window, filters, options) =>
                fetchUtmTrend(siteId, window, tab, filters, options),
            }),
          );
        }
      }
      return { reads: null };
    }
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "campaigns",
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
  const { reads } = Route.useLoaderData();
  return (
    <CampaignsClientPage
      deferredReads={reads}
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
