import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { RetentionClientPage } from "@/components/dashboard/site-pages/retention-client-page";

interface ShareRetentionPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareRetentionPage({
  params,
}: ShareRetentionPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <RetentionClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      pathname={sharePath(context.locale, slug, "retention")}
    />
  );
}
