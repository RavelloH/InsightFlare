import { createFileRoute } from "@tanstack/react-router";

import { CampaignsClientPage } from "@/components/dashboard/site-pages/campaigns/campaigns-client-page";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/campaigns")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <CampaignsClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      pathname={sharePath(locale, slug, "campaigns")}
    />
  );
}
