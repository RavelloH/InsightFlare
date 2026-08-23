import { createFileRoute } from "@tanstack/react-router";

import { ReferrersClientPage } from "@/components/dashboard/site-pages/referrers-client-page";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/referrers")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <ReferrersClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      pathname={sharePath(locale, slug, "referrers")}
      showSourceLinkTab={false}
    />
  );
}
