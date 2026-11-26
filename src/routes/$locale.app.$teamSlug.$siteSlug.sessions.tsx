import { createFileRoute } from "@tanstack/react-router";

import { SessionsClientPage } from "@/components/dashboard/site-pages/sessions/sessions-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { sessionsListQueryOptions } from "@/lib/dashboard/client/data/sessions";
import { buildSitePath } from "@/lib/dashboard/paths";
import { canPrefetchAnalyticsNavigation } from "@/lib/dashboard/query-preferences";
import { parseFilterDocumentFromSearchParams } from "@/lib/dashboard/query-state";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { attachFilterScopePreference } from "@/lib/filter-contract";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/sessions",
)({
  preloadStaleTime: 0,
  loader: async ({ context, location, preload, cause }) => {
    if (typeof window !== "undefined") {
      if (
        canPrefetchAnalyticsNavigation({
          preload,
          cause,
          window: context.initialDashboardWindow,
          accountTimeZone: context.siteContext.user.timeZone,
        })
      ) {
        const siteId = context.siteContext.activeSite.id;
        const window = context.initialDashboardWindow;
        const search = new URLSearchParams(location.searchStr);
        const document = parseFilterDocumentFromSearchParams(search);
        const filters = document.root
          ? document
          : attachFilterScopePreference(document, "auto");
        const client = getBrowserQueryClient();
        const list = sessionsListQueryOptions({ siteId, window, filters });
        if (client.getQueryData(list.queryKey) === undefined)
          void client.prefetchInfiniteQuery(list);
      }
      return { reads: null };
    }
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "sessions",
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
          match.context.messages.sessions.title,
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
    <SessionsClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "sessions",
      )}
    />
  );
}
