import type { Metadata } from "next";

import { OverviewClientPage } from "@/components/dashboard/site-pages/overview-client-page";
import { formatI18nTemplate } from "@/lib/i18n/template";

import { getShareRouteContext, sharePath } from "./share-utils";

interface SharePageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export async function generateMetadata({
  params,
}: SharePageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);
  return {
    title: formatI18nTemplate(context.messages.share.title, {
      siteName: context.site.name,
    }),
  };
}

export default async function ShareOverviewPage({ params }: SharePageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <OverviewClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      siteDomain={context.site.domain}
      pathname={sharePath(context.locale, slug)}
    />
  );
}
