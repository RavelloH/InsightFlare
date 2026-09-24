import { createFileRoute } from "@tanstack/react-router";

import { GeoClientPage } from "@/components/dashboard/site-pages/geo/geo-client-page";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug/geo")({
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
  return (
    <GeoClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
    />
  );
}
