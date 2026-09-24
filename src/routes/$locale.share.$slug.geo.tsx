import { createFileRoute } from "@tanstack/react-router";

import { GeoClientPage } from "@/components/dashboard/site-pages/geo/geo-client-page";
export const Route = createFileRoute("/$locale/share/$slug/geo")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  return (
    <GeoClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
    />
  );
}
