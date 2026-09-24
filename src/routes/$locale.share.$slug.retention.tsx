import { createFileRoute } from "@tanstack/react-router";

import { RetentionClientPage } from "@/components/dashboard/site-pages/retention/retention-client-page";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/retention")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <RetentionClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      pathname={sharePath(locale, slug, "retention")}
    />
  );
}
