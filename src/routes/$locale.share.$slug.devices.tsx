import { createFileRoute } from "@tanstack/react-router";

import { DevicesClientPage } from "@/components/dashboard/site-pages/devices/devices-client-page";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/devices")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <DevicesClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      siteDomain={c.site.domain}
      pathname={sharePath(locale, slug, "devices")}
    />
  );
}
