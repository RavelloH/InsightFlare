import { notFound } from "next/navigation";

import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { PageDetailClientPage } from "@/components/dashboard/site-pages/page-detail-client-page";
import {
  normalizePagePath,
  PAGE_DETAIL_QUERY_PARAM,
} from "@/lib/dashboard/page-detail";

interface SharePageDetailPageProps {
  params: Promise<{
    locale: string;
    slug: string;
    pageKey: string;
  }>;
  searchParams: Promise<{
    pagePath?: string;
  }>;
}

export default async function SharePageDetailPage({
  params,
  searchParams,
}: SharePageDetailPageProps) {
  const { locale, slug } = await params;
  const search = await searchParams;
  const pagePath = normalizePagePath(search[PAGE_DETAIL_QUERY_PARAM]);

  if (!pagePath) notFound();

  const context = await getShareRouteContext(locale, slug);

  return (
    <PageDetailClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      siteDomain={context.site.domain}
      pathname={sharePath(context.locale, slug, "pages")}
      pagePath={pagePath}
    />
  );
}
