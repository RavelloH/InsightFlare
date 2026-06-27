import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { PagesClientPage } from "@/components/dashboard/site-pages/pages-client-page";

interface SharePagesPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function SharePagesPage({ params }: SharePagesPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <PagesClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      pathname={sharePath(context.locale, slug, "pages")}
    />
  );
}
