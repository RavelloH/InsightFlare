import { getShareRouteContext } from "@/app/[locale]/share/[slug]/share-utils";
import { PerformanceClientPage } from "@/components/dashboard/site-pages/performance-client-page";

interface SharePerformancePageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function SharePerformancePage({
  params,
}: SharePerformancePageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <PerformanceClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
    />
  );
}
