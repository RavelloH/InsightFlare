import { createFileRoute } from "@tanstack/react-router";

import { BrowsersClientPage } from "@/components/dashboard/site-pages/browsers/browsers-client-page";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/browsers")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <BrowsersClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      pathname={sharePath(locale, slug, "browsers")}
    />
  );
}
