import { createFileRoute } from "@tanstack/react-router";

import { deviceCrossBreakdownQueryOptions } from "@/components/dashboard/devices/device-cross-breakdown-grid";
import { shareTrendQueryOptions } from "@/components/dashboard/sharing/share-trend-card";
import { DevicesClientPage } from "@/components/dashboard/site-pages/devices/devices-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import {
  fetchDeviceTypeTrend,
  fetchOperatingSystemTrend,
} from "@/lib/dashboard/client/data/browser";
import { buildSitePath } from "@/lib/dashboard/paths";
import { analyticsNavigationInput } from "@/lib/dashboard/query-preferences";
import { loadSiteAnalyticsStream } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/devices",
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
        void client.prefetchQuery(
          shareTrendQueryOptions({
            ...input,
            queryKey: ["device-dimension", "deviceType"],
            fetchTrend: fetchDeviceTypeTrend,
          }),
        );
        void client.prefetchQuery(
          shareTrendQueryOptions({
            ...input,
            queryKey: ["device-dimension", "operatingSystem"],
            fetchTrend: fetchOperatingSystemTrend,
          }),
        );
        void client.prefetchQuery(
          deviceCrossBreakdownQueryOptions(input, "browser"),
        );
        void client.prefetchQuery(
          deviceCrossBreakdownQueryOptions(input, "operatingSystem"),
        );
      }
      return { reads: null };
    }
    return {
      reads: await loadSiteAnalyticsStream({
        data: {
          page: "devices",
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
          match.context.messages.devices.title,
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
    <DevicesClientPage
      deferredReads={reads}
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      siteDomain={c.activeSite.domain}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "devices",
      )}
    />
  );
}
