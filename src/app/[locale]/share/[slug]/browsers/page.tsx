import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { BrowsersClientPage } from "@/components/dashboard/site-pages/browsers-client-page";

interface ShareBrowsersPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareBrowsersPage({
  params,
}: ShareBrowsersPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <BrowsersClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      pathname={sharePath(context.locale, slug, "browsers")}
    />
  );
}
