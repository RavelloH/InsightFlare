import { createFileRoute } from "@tanstack/react-router";

import { DevicesClientPage } from "@/components/dashboard/site-pages/devices/devices-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/devices",
)({
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
  return (
    <DevicesClientPage
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
