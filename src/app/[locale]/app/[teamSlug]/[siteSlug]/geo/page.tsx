import { notFound } from "next/navigation";
import { GeoClientPage } from "@/components/dashboard/site-pages/geo-client-page";
import { getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface GeoPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function GeoPage({ params }: GeoPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  return (
    <GeoClientPage
      locale={resolvedLocale}
      messages={messages}
      siteId={context.activeSite.id}
    />
  );
}
