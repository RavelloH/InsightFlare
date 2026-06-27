import {
  getShareRouteContext,
  sharePath,
} from "@/app/[locale]/share/[slug]/share-utils";
import { DevicesClientPage } from "@/components/dashboard/site-pages/devices-client-page";

interface ShareDevicesPageProps {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export default async function ShareDevicesPage({
  params,
}: ShareDevicesPageProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <DevicesClientPage
      locale={context.locale}
      messages={context.messages}
      siteId={context.publicSiteId}
      siteDomain={context.site.domain}
      pathname={sharePath(context.locale, slug, "devices")}
    />
  );
}
