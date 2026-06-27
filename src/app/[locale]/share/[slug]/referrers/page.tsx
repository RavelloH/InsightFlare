import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { ReferrersClientPage } from "@/components/dashboard/site-pages/referrers-client-page";

interface ShareReferrersPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareReferrersPage({
  params,
}: ShareReferrersPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <ReferrersClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      pathname={sharePath(context.locale, slug, "referrers")}
    />
  );
}
