import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageDetailClientPage } from "@/components/dashboard/site-pages/page-detail-client-page";
import {
  normalizePagePath,
  PAGE_DETAIL_QUERY_PARAM,
} from "@/lib/dashboard/page-detail";
import { sharePath } from "@/lib/dashboard/share-path";
export const Route = createFileRoute("/$locale/share/$slug/pages_/$pageKey")({
  validateSearch: (search: Record<string, unknown>) => ({
    pagePath: typeof search.pagePath === "string" ? search.pagePath : undefined,
  }),
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const pagePath = normalizePagePath(
    Route.useSearch()[PAGE_DETAIL_QUERY_PARAM],
  );
  if (!pagePath) throw notFound();
  return (
    <PageDetailClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
      siteDomain={c.site.domain}
      pathname={sharePath(locale, slug)}
      pagePath={pagePath}
      showSourceLinkTab={false}
    />
  );
}
