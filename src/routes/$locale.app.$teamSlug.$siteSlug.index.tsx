import { createFileRoute } from "@tanstack/react-router";

import { overviewSummaryQueryOptions } from "@/components/dashboard/site-pages/overview/metrics-data";
import { OverviewClientPage } from "@/components/dashboard/site-pages/overview/overview-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { resolveFilterScope } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  attachFilterScopePreference,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/")({
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
        preserveEmptyScope: true,
      });
      if (input) {
        const client = getBrowserQueryClient();
        const scope = resolveFilterScope(
          "overview",
          filterScopePreferenceFromDocument(input.filters) ?? "auto",
        );
        const filters = scope
          ? attachFilterScopePreference(input.filters, scope)
          : input.filters;
        void client.prefetchQuery(
          overviewSummaryQueryOptions({
            ...input,
            filters,
            comparisonQuery: resolveDashboardComparisonQuery(
              input.search,
              input.window,
              filters,
            ),
          }),
        );
      }
      return { reads: null };
    }
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
