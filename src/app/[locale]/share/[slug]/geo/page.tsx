import { getShareRouteContext } from "@/app/[locale]/share/[slug]/share-utils";
import { GeoClientPage } from "@/components/dashboard/site-pages/geo-client-page";

interface ShareGeoPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareGeoPage({ params }: ShareGeoPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <GeoClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
    />
  );
}
