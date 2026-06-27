import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { CampaignsClientPage } from "@/components/dashboard/site-pages/campaigns-client-page";

interface ShareCampaignsPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareCampaignsPage({
  params,
}: ShareCampaignsPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <CampaignsClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      pathname={sharePath(context.locale, slug, "campaigns")}
    />
  );
}
